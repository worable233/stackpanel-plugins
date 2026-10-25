import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@stackpanel/sdk';
vi.mock('./repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repository.js')>()),
  listUpstreams: vi.fn(),
  listBoundProducts: vi.fn(),
}));
import { listUpstreams, listBoundProducts } from './repository.js';
import { ZJMFUpstreamService, zjmfUpstreamPlugin } from './index.js';
import { ZJMFClient } from './zjmf-client.js';

describe('upstream inventory', () => {
  it('includes unmapped and disabled-account instances and preserves account-scoped ownership', async () => {
    vi.mocked(listUpstreams).mockResolvedValue([
      { id: 'a', name: 'A', enabled: true },
      { id: 'b', name: 'B', enabled: false },
    ] as never);
    vi.mocked(listBoundProducts).mockResolvedValue([
      {
        product: { id: 'local', name: 'Local cloud' },
        binding: { sourceRef: 'a', productId: '7', providerId: 'zjmf' },
      },
    ] as never);
    const ctx = {
      getExtensions: () => [
        {
          listBoundServices: async () => [
            {
              id: 'bound',
              userId: 'user',
              providerServiceId: '42',
              runtime: { upstreamId: 'a' },
            },
          ],
        },
      ],
    } as unknown as PluginContext;
    const service = new ZJMFUpstreamService(ctx);
    vi.spyOn(service as never, 'connectionFor' as never).mockResolvedValue({} as never);
    const spy = vi
      .spyOn(ZJMFClient.prototype, 'listHosts')
      .mockImplementation(
        async () => [{ id: '42', name: 'Existing', productId: '7', status: 'Active' }] as never,
      );
    const detailSpy = vi.spyOn(ZJMFClient.prototype, 'getService').mockResolvedValue({
      expiresAt: '2027-01-01T00:00:00.000Z',
      openedAt: '2026-01-01T08:30:00.000Z',
    });
    const result = await service.inventory();
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0]).toMatchObject({
      products: [{ id: 'local' }],
      boundUserId: 'user',
      expiresAt: '2027-01-01T00:00:00.000Z',
      openedAt: '2026-01-01T08:30:00.000Z',
    });
    expect(result.instances[1]).toMatchObject({
      products: [],
      boundUserId: null,
      sourceRef: 'b',
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(detailSpy).toHaveBeenCalledTimes(2);
    detailSpy.mockRestore();
    spy.mockRestore();
  });
  it('reports upstream failures as stable codes instead of stored copy', async () => {
    vi.mocked(listUpstreams).mockResolvedValue([{ id: 'a', name: 'A', enabled: true }] as never);
    vi.mocked(listBoundProducts).mockResolvedValue([] as never);
    const service = new ZJMFUpstreamService({
      getExtensions: () => [],
    } as unknown as PluginContext);
    const connect = vi
      .spyOn(service as never, 'connectionFor' as never)
      .mockRejectedValue(new Error('upstream said: bad token'));
    const unreachable = await service.inventory();
    expect(unreachable.errors).toEqual([
      { sourceName: 'A', code: 'zjmf.instances_unavailable', detail: null },
    ]);
    // ADR-0012: no upstream text and no server-authored sentence in the payload.
    expect(JSON.stringify(unreachable.errors)).not.toContain('bad token');
    connect.mockResolvedValue({} as never);
    const listHosts = vi
      .spyOn(ZJMFClient.prototype, 'listHosts')
      .mockResolvedValue([{ id: '42', name: 'Host', productId: '7', status: 'Active' }] as never);
    const detail = vi
      .spyOn(ZJMFClient.prototype, 'getService')
      .mockRejectedValue(new Error('timeout'));
    const partial = await service.inventory();
    expect(partial.errors).toEqual([
      { sourceName: 'A', code: 'zjmf.instance_detail_unavailable', detail: '42' },
    ]);
    detail.mockRestore();
    listHosts.mockRestore();
    connect.mockRestore();
  });
  it('protects inventory using the upstream admin permission', () => {
    expect(
      zjmfUpstreamPlugin.routes?.find((route) => route.path === '/zjmf-upstream/admin/instances'),
    ).toMatchObject({
      method: 'GET',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
    });
  });
});
