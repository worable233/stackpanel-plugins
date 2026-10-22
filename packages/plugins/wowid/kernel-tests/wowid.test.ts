import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { hashPassword } from '../../src/lib/password.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('wowid OAuth integration (mock, real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `wow_admin_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';

  beforeAll(async () => {
    process.env['WOWID_MOCK'] = 'true';
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    adminToken = admin.token;
    await prisma.plugin.deleteMany({ where: { id: 'wowid' } });
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/wowid',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.plugin.deleteMany({ where: { id: 'wowid' } });
    await prisma.userIdentity.deleteMany({ where: { providerId: 'wowid' } });
    await prisma.user.deleteMany({
      where: { email: { in: [adminEmail, 'demo@wowid.example'] } },
    });
    await app.close();
  });

  it('returns an authorization URL for the active provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/oauth/wowid/authorize' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizeUrl: string; state: string };
    expect(body.state).toBeTruthy();
    const url = new URL(body.authorizeUrl);
    expect(url.pathname).toBe('/auth/oauth/wowid/callback');
    expect(url.searchParams.get('code')).toBe('wowid_mock');
    expect(url.searchParams.get('state')).toBe(body.state);
  });

  it('lists the active provider without exposing configuration', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/oauth/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [{ id: 'wowid', name: 'Wow ID' }] });
  });

  it('completes login and auto-provisions a local user', async () => {
    const authorize = await app.inject({ method: 'GET', url: '/auth/oauth/wowid/authorize' });
    const { state } = authorize.json() as { state: string };

    const cb = await app.inject({
      method: 'POST',
      url: '/auth/oauth/wowid/callback',
      payload: { code: 'wowid_mock', state },
    });
    expect(cb.statusCode).toBe(200);
    const body = cb.json() as { token: string; user: { id: string; email: string; status: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('demo@wowid.example');
    expect(body.user.status).toBe('ACTIVE');

    // A provisioned OAuth user is a regular user: it lacks admin permissions.
    const check = await app.inject({
      method: 'GET',
      url: '/permissions/check?permission=platform.admin',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { allowed: boolean }).allowed).toBe(false);

    const prisma = getPrisma();
    const identity = await prisma.userIdentity.findFirstOrThrow({ where: { providerId: 'wowid' } });
    expect(identity.externalId).toBe('wowid_demo_user');
    expect(identity.userId).toBe(body.user.id);
  });

  it('reuses the same local user on a second login', async () => {
    const authorize = await app.inject({ method: 'GET', url: '/auth/oauth/wowid/authorize' });
    const { state } = authorize.json() as { state: string };
    const cb = await app.inject({
      method: 'POST',
      url: '/auth/oauth/wowid/callback',
      payload: { code: 'wowid_mock', state },
    });
    expect(cb.statusCode).toBe(200);
    const first = await app.inject({
      method: 'POST',
      url: '/auth/oauth/wowid/callback',
      payload: { code: 'wowid_mock', state: 'any-state' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { user: { id: string } };
    const second = await app.inject({
      method: 'POST',
      url: '/auth/oauth/wowid/callback',
      payload: { code: 'wowid_mock', state: 'any-state' },
    });
    const secondBody = second.json() as { user: { id: string } };
    expect(secondBody.user.id).toBe(firstBody.user.id);
  });

  it('rejects an email already registered locally with 409', async () => {
    const prisma = getPrisma();
    await prisma.userIdentity.deleteMany({ where: { providerId: 'wowid' } });
    await prisma.user.deleteMany({ where: { email: 'demo@wowid.example' } });
    await prisma.user.create({
      data: {
        email: 'demo@wowid.example',
        passwordHash: await hashPassword(password),
        status: 'ACTIVE',
      },
    });
    const cb = await app.inject({
      method: 'POST',
      url: '/auth/oauth/wowid/callback',
      payload: { code: 'wowid_mock', state: 'any-state' },
    });
    expect(cb.statusCode).toBe(409);
    await prisma.user.deleteMany({ where: { email: 'demo@wowid.example' } });
  });

  it('returns 404 for OAuth routes once the plugin is disabled', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/wowid',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/auth/oauth/wowid/authorize' });
    expect(res.statusCode).toBe(404);
    const providers = await app.inject({ method: 'GET', url: '/auth/oauth/providers' });
    expect(providers.json()).toEqual({ providers: [] });
  });
});
