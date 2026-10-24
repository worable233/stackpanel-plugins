import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 工单生命周期（#9）。
 *
 * 与 `ticket.test.ts` 分开：那个文件只验证既有接口，用例顺序和计数都被别处
 * 依赖（分页总数、按状态过滤的条数）。这里全部用**自己的**工单，避免把它的
 * 期望值挤歪。
 */
describe.skipIf(!dbAvailable)('ticket lifecycle (real DB)', () => {
  let app: FastifyInstance;
  const password = 'IntegrationPass123';
  const stamp = Date.now();
  const adminEmail = `tl_admin_${stamp}@example.com`;
  const userEmail = `tl_user_${stamp}@example.com`;
  const otherEmail = `tl_other_${stamp}@example.com`;
  let adminToken = '';
  let adminId = '';
  let userToken = '';
  let otherToken = '';
  const userIds: string[] = [];

  /** 建一张工单，返回 id。 */
  async function createTicket(subject: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/tickets',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { subject, body: 'initial body' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { ticket: { id: string } }).ticket.id;
  }

  async function adminPatch(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/ticket/admin/tickets/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
  }

  async function readAsAdmin(id: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/ticket/admin/tickets/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    // 管理端详情是扁平结构（`...toTicketView(ticket)` 直接展开），没有 ticket 包装层。
    return res.json() as {
      status: string;
      assigneeId: string | null;
      reminderCount: number;
      category: string | null;
      departmentId: string | null;
      messages: Array<{ body: string; internal?: boolean }>;
    };
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    const other = await createTestUser(app, otherEmail, password);
    adminToken = admin.token;
    adminId = admin.userId;
    userToken = user.token;
    otherToken = other.token;
    userIds.push(admin.userId, user.userId, other.userId);

    await getPrisma().plugin.deleteMany({ where: { id: 'ticket' } });
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

  describe('user closes a ticket', () => {
    it('closes with the reason appended to the timeline', async () => {
      const id = await createTicket('Close me');
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { reason: '问题已自己解决' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ticket: { status: string } }).ticket.status).toBe('CLOSED');

      const view = await readAsAdmin(id);
      expect(view.status).toBe('CLOSED');
      // 关闭原因必须是普通消息，时间线才不断档。
      expect(view.messages.some((m) => m.body === '问题已自己解决')).toBe(true);
    });

    it('is idempotent — closing twice does not duplicate the reason', async () => {
      const id = await createTicket('Close twice');
      const payload = { reason: '重复关闭' };
      const first = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload,
      });
      expect(second.statusCode).toBe(200);

      const view = await readAsAdmin(id);
      expect(view.messages.filter((m) => m.body === '重复关闭').length).toBe(1);
    });

    it('refuses to close someone else ticket', async () => {
      const id = await createTicket('Not yours');
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/close`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects replies and reminders once closed', async () => {
      const id = await createTicket('Closed is terminal');
      await app.inject({
        method: 'POST',
        url: `/tickets/${id}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });

      const reply = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: 'still there?' },
      });
      expect(reply.statusCode).toBe(409);

      const remind = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      expect(remind.statusCode).toBe(409);
    });
  });

  describe('user reminds', () => {
    it('counts the reminder without polluting the timeline', async () => {
      const id = await createTicket('Remind me');
      const before = await readAsAdmin(id);

      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ticket: { reminderCount: number } }).ticket.reminderCount).toBe(1);

      const after = await readAsAdmin(id);
      // 催单不该写消息，否则时间线被无意义的重复行淹没。
      expect(after.messages.length).toBe(before.messages.length);
    });

    it('rejects a second reminder inside the cooldown window', async () => {
      const id = await createTicket('Remind twice');
      const first = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/remind`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      expect(second.statusCode).toBe(429);
    });

    it('refuses to remind someone else ticket', async () => {
      const id = await createTicket('Not yours to remind');
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/remind`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('admin accepts and transfers', () => {
    it('derives IN_PROGRESS when assigning an OPEN ticket', async () => {
      const id = await createTicket('Assign to me');
      const res = await adminPatch(id, { assigneeId: adminId });
      expect(res.statusCode).toBe(200);
      const ticket = (res.json() as { ticket: { status: string; assigneeId: string } }).ticket;
      expect(ticket.status).toBe('IN_PROGRESS');
      expect(ticket.assigneeId).toBe(adminId);
    });

    it('keeps the status when transferring to another assignee', async () => {
      const id = await createTicket('Transfer me');
      await adminPatch(id, { assigneeId: adminId, status: 'IN_PROGRESS' });

      const res = await adminPatch(id, { assigneeId: userIds[1] as string });
      expect(res.statusCode).toBe(200);
      const ticket = (res.json() as { ticket: { status: string; assigneeId: string } }).ticket;
      // 转交只换人，不该顺带改状态。
      expect(ticket.status).toBe('IN_PROGRESS');
      expect(ticket.assigneeId).toBe(userIds[1]);
    });

    it('refuses to reopen a CLOSED ticket', async () => {
      const id = await createTicket('Stay closed');
      await app.inject({
        method: 'POST',
        url: `/tickets/${id}/close`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {},
      });
      const res = await adminPatch(id, { status: 'OPEN' });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('status machine', () => {
    it('moves to PENDING_USER on an admin reply', async () => {
      const id = await createTicket('Waiting for user');
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: 'We need more details' },
      });
      expect(res.statusCode).toBe(201);

      const view = await readAsAdmin(id);
      expect(view.status).toBe('PENDING_USER');
    });

    it('reopens a RESOLVED ticket when the user replies', async () => {
      const id = await createTicket('Resolved then reopened');
      await adminPatch(id, { status: 'RESOLVED' });

      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: 'Actually it is not fixed' },
      });
      expect(res.statusCode).toBe(201);

      const view = await readAsAdmin(id);
      expect(view.status).toBe('IN_PROGRESS');
    });
  });

  describe('internal notes', () => {
    it('hides internal notes from the ticket owner', async () => {
      const id = await createTicket('Has internal note');
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { body: 'customer is on the enterprise plan', internal: true },
      });
      expect(res.statusCode).toBe(201);

      const asAdmin = await readAsAdmin(id);
      expect(asAdmin.messages.some((m) => m.body === 'customer is on the enterprise plan')).toBe(
        true,
      );

      const asUser = await app.inject({
        method: 'GET',
        url: `/tickets/${id}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(asUser.statusCode).toBe(200);
      const userView = asUser.json() as { messages: Array<{ body: string }> };
      expect(userView.messages.some((m) => m.body === 'customer is on the enterprise plan')).toBe(
        false,
      );
    });

    it('refuses an internal note written by a non-admin', async () => {
      const id = await createTicket('User tries internal');
      const res = await app.inject({
        method: 'POST',
        url: `/tickets/${id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { body: 'sneaky', internal: true },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('classification and related objects', () => {
    it('stores category and department', async () => {
      const id = await createTicket('Needs classification');
      const res = await adminPatch(id, {
        category: 'billing',
        departmentId: 'dept-support',
      });
      expect(res.statusCode).toBe(200);
      const ticket = (res.json() as { ticket: { category: string; departmentId: string } }).ticket;
      expect(ticket.category).toBe('billing');
      expect(ticket.departmentId).toBe('dept-support');
    });

    it('accepts a related object supplied as a pair at creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tickets',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          subject: 'Order never arrived',
          body: 'tracking shows delivered',
          relatedType: 'order',
          relatedId: 'order-123',
        },
      });
      expect(res.statusCode).toBe(201);
      const ticket = (res.json() as { ticket: { relatedType: string; relatedId: string } }).ticket;
      expect(ticket.relatedType).toBe('order');
      expect(ticket.relatedId).toBe('order-123');
    });

    it('rejects a half-specified related object at creation', async () => {
      // relatedType / relatedId 必须成对出现：单边数据没有追溯价值。
      const res = await app.inject({
        method: 'POST',
        url: '/tickets',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { subject: 'Related mismatch', body: 'body', relatedType: 'order' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('admin filters', () => {
    it('filters to the unassigned queue', async () => {
      const id = await createTicket('Queue member');
      const res = await app.inject({
        method: 'GET',
        url: '/ticket/admin/tickets?unassigned=true&pageSize=100',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { tickets: Array<{ id: string; assigneeId: string | null }> };
      expect(body.tickets.every((t) => t.assigneeId === null)).toBe(true);
      expect(body.tickets.some((t) => t.id === id)).toBe(true);
    });
  });
});
