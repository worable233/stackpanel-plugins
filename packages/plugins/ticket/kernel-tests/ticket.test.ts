import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('ticket plugin integration (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `tk_admin_${Date.now()}@example.com`;
  const userEmail = `tk_user_${Date.now()}@example.com`;
  const otherEmail = `tk_other_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let otherToken = '';
  let ticketId = '';
  const userIds: string[] = [];

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    const other = await createTestUser(app, otherEmail, password);
    userIds.push(admin.userId, user.userId, other.userId);
    adminToken = admin.token;
    userToken = user.token;
    otherToken = other.token;
    await prisma.plugin.deleteMany({ where: { id: 'ticket' } });

    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/ticket',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.plugin.deleteMany({ where: { id: 'ticket' } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('requires auth on user ticket routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/tickets' });
    expect(res.statusCode).toBe(401);
  });

  it('lets a user create a ticket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tickets',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { subject: 'Cannot install plugin', body: 'It fails at runtime' },
    });
    expect(res.statusCode).toBe(201);
    ticketId = (res.json() as { ticket: { id: string } }).ticket.id;
  });

  it('lists only the user own tickets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tickets',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tickets: Array<{ id: string; subject: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.tickets[0]?.id).toBe(ticketId);
  });

  it('lets a user reply to their ticket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/tickets/${ticketId}/messages`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { body: 'Added logs, please check' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 403 when a user reads another user ticket', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('shows the ticket with messages to an admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/ticket/admin/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ body: string }> };
    expect(body.messages.length).toBe(2);
  });

  it('lets an admin update the status and assignee', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/ticket/admin/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'IN_PROGRESS', priority: 'HIGH', assigneeId: userIds[1] as string },
    });
    expect(res.statusCode).toBe(200);
    const ticket = (res.json() as { ticket: { status: string; priority: string } }).ticket;
    expect(ticket.status).toBe('IN_PROGRESS');
    expect(ticket.priority).toBe('HIGH');
  });

  it('paginates the admin ticket list', async () => {
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/tickets',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { subject: `Pagination ticket ${i}`, body: 'body' },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/ticket/admin/tickets?page=1&pageSize=2',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tickets: unknown[]; total: number; page: number };
    expect(body.total).toBe(4);
    expect(body.tickets.length).toBe(2);
    expect(body.page).toBe(1);
  });

  it('filters the admin ticket list by status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ticket/admin/tickets?status=OPEN',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = res.json() as { total: number };
    expect(body.total).toBe(3);
  });
});
