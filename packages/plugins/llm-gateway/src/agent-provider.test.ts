import { beforeEach, describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  rows: new Map<string, { spec: { hash: string; status: string; result?: unknown } }>(),
  secret: JSON.stringify({ token: 'site-sponsor-secret', ip: '192.0.2.1' }),
  calls: 0,
  charged: true,
  lastHeaders: {} as Record<string, unknown>,
}));
vi.mock('./context.js', () => ({
  secrets: () => ({
    get: async () => fixture.secret,
    set: async (_key: string, value: string) => {
      fixture.secret = value;
    },
    remove: async () => {
      fixture.secret = '';
    },
  }),
  auth: () => ({
    inspectPlatformToken: async () => ({
      token: { userId: 'admin', scopes: ['llm-gateway.use'] },
      active: true,
      expired: false,
      ipAllowed: true,
    }),
    hasPermission: async () => true,
  }),
  extensions: () => ({
    get: async (_model: unknown, id: string) => fixture.rows.get(id) ?? null,
    create: async (
      _model: unknown,
      value: { hash: string; status: string },
      options: { name: string },
    ) => {
      if (fixture.rows.has(options.name)) throw new Error('duplicate');
      fixture.rows.set(options.name, { spec: value });
    },
    update: async (
      _model: unknown,
      id: string,
      value: { hash: string; status: string; result?: unknown },
    ) => {
      fixture.rows.set(id, { spec: value });
    },
  }),
}));
vi.mock('./repository.js', () => ({
  listEnabledPrices: async () => [
    {
      model: 'fixture',
      inputPrice: 100,
      outputPrice: 200,
      cacheReadPrice: 20,
      cacheWritePrice: 300,
      reasoningPrice: 400,
      multiplier: 200,
    },
  ],
}));
vi.mock('./relay.js', () => ({
  createRelayHandler:
    () =>
    async (
      request: { headers: Record<string, unknown> },
      reply: { header: (key: string, value: string) => unknown; end: (body: string) => void },
    ) => {
      fixture.calls++;
      fixture.lastHeaders = request.headers;
      if (fixture.charged) reply.header('x-stackpanel-charge-minor', '5');
      reply.end(
        JSON.stringify({
          model: 'fixture',
          choices: [{ finish_reason: 'stop', message: { content: 'answer' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    },
}));
const { createAgentProvider, configureAgentProvider } = await import('./agent-provider.js');
beforeEach(() => {
  fixture.rows.clear();
  fixture.calls = 0;
  fixture.charged = true;
  fixture.secret = JSON.stringify({ token: 'site-sponsor-secret', ip: '192.0.2.1' });
});
describe('Kernel Agent gateway provider', () => {
  const request = { model: 'fixture', messages: [] };
  const options = { callId: 'stable-call', actorId: 'user', runId: 'run' };
  it('uses the site sponsor and replays a finished result without recharging', async () => {
    const provider = createAgentProvider(() => null);
    const first = await provider.complete(request, options);
    expect(first.costMinor).toBe(5);
    expect(first.parts).toEqual([{ type: 'text', text: 'answer' }]);
    expect(fixture.lastHeaders.authorization).toBe('Bearer site-sponsor-secret');
    expect(await provider.complete(request, options)).toEqual(first);
    expect(fixture.calls).toBe(1);
    await expect(provider.complete({ ...request, model: 'changed' }, options)).rejects.toThrow();
  });
  it('never interprets a missing billing header as free inference', async () => {
    fixture.charged = false;
    const provider = createAgentProvider(() => null);
    await expect(provider.complete(request, options)).rejects.toThrow();
    await expect(provider.complete(request, options)).rejects.toThrow();
    expect(fixture.calls).toBe(1);
  });
  it('publishes upper pricing including cache-write and reasoning rates', async () => {
    expect((await createAgentProvider(() => null).listModels())[0]).toMatchObject({
      inputPriceMinorPerMillion: 600,
      outputPriceMinorPerMillion: 800,
    });
  });
  it('requires the configuring administrator to own the sponsor credential', async () => {
    await expect(
      configureAgentProvider({ user: { id: 'someone-else' }, body: { token: 'sponsor' } } as never),
    ).rejects.toMatchObject({ code: 'llm_gateway.agent_sponsor_invalid' });
  });
  it('declines supply cleanly when no sponsor has been configured', async () => {
    fixture.secret = '';
    const provider = createAgentProvider(() => null);
    expect(await provider.available()).toBe(false);
    await expect(provider.complete(request, options)).rejects.toThrow();
    expect(fixture.calls).toBe(0);
  });
});
