import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * The ticket plugin is an ordinary installable package, not part of the kernel.
 *
 * This suite pins that down, because "installable" is not just a label in
 * `package.json`: if the installed manifest claimed `builtin: true`, the kernel
 * would run the plugin in-process with full kernel privileges, grant it
 * server-side execution in the web process, and refuse to uninstall it. These
 * assertions fail the moment any of that creeps back in.
 */
describe.skipIf(!dbAvailable)('ticket installs as a non-builtin, isolated plugin', () => {
  let app: FastifyInstance;
  let adminToken = '';
  let adminId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(
      app,
      `tk_iso_${Date.now()}@example.com`,
      'IntegrationPass123',
    );
    adminToken = admin.token;
    adminId = admin.userId;
    await getPrisma().plugin.deleteMany({ where: { id: 'ticket' } });
  });

  afterAll(async () => {
    await getPrisma().plugin.deleteMany({ where: { id: 'ticket' } });
    await getPrisma().user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('is loaded with no kernel privileges', () => {
    const plugin = app.pluginRuntime.list().find((item) => item.id === 'ticket');
    expect(plugin).toBeDefined();
    // Not built-in ⇒ the kernel loads it out-of-process and will let an
    // operator uninstall it.
    expect(plugin?.builtin).toBe(false);
    // Isolated, not in-process `trusted`.
    expect(plugin?.execution).toBe('isolated');
    // No web-process server execution: the admin/user surfaces call the HTTP
    // API like any other client instead of running kernel-side code.
    expect(plugin?.frontendExecutions).toBe('declarative');
    // Uninstall policy is its own decision, not a consequence of `builtin`.
    // An installed package is removable; a kernel-shipped one is not.
    expect(plugin?.removable).toBe(true);
  });

  it('is discovered as dynamic and stays disabled until an admin enables it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/plugins',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{
        id: string;
        enabled: boolean;
        source: string;
        /** Independent of `source` (kernel-owned uninstall policy). */
        removable: boolean;
        frontend?: { available: boolean };
      }>;
    };
    const ticket = body.plugins.find((item) => item.id === 'ticket');
    expect(ticket).toBeDefined();
    // `source: 'dynamic'` is provenance: the package does not ship with the
    // kernel image.
    expect(ticket?.source).toBe('dynamic');
    // Uninstallability is a separate decision; this is what enables the delete
    // action in the admin UI.
    expect(ticket?.removable).toBe(true);
    // Optional installations must not switch themselves on.
    expect(ticket?.enabled).toBe(false);
    // Its admin/user surfaces are still registered.
    expect(ticket?.frontend?.available).toBe(true);
  });
});
