import { describe, expect, it, vi } from 'vitest';
import {
  applyMarkup,
  decimalToMinor,
  isUnsafeIpAddress,
  normalizeBaseUrl,
  ZJMFClient,
  ZJMFClientError,
} from './zjmf-client.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ZJMFClient', () => {
  it('uses the legacy V1 JWT field and product routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'legacy-jwt' });
      if (path === '/api/product/list') {
        return json({
          status: 200,
          data: { currency_code: 'CNY', list: [{ id: 7, name: 'VPS', price: '9.90' }] },
        });
      }
      return json({
        status: 200,
        data: { product: { id: 7, name: 'VPS', description: '1C1G', price: '9.90' } },
      });
    });
    const client = new ZJMFClient(
      {
        id: 'legacy',
        baseUrl: 'https://finance.example',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );

    const listed = await client.listProducts();
    const detail = await client.getProduct('7');

    expect(listed.currency).toBe('CNY');
    expect(listed.products).toMatchObject([{ id: '7', name: 'VPS', price: '9.90' }]);
    expect(detail.description).toBe('1C1G');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer legacy-jwt',
    });
  });

  it('uses the V10 nested JWT field and retries an expired token once', async () => {
    let loginCount = 0;
    let productCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') {
        loginCount += 1;
        return json({ status: 200, data: { jwt: `v10-${loginCount}` } });
      }
      productCount += 1;
      return productCount === 1
        ? json({ status: 401, msg: 'expired' })
        : json({ status: 200, data: { list: [{ id: 'a', name: 'Cloud', sale_price: '12.34' }] } });
    });
    const client = new ZJMFClient(
      { id: 'v10', baseUrl: 'https://v10.example/', protocol: 'v10', username: 'u', password: 'p' },
      fetchMock,
    );

    const listed = await client.listProducts();

    expect(listed.products[0]).toMatchObject({ id: 'a', price: '12.34' });
    expect(loginCount).toBe(2);
    expect(productCount).toBe(2);
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer v10-2' });
  });
});

describe('ZJMF value normalization', () => {
  it('converts prices exactly and applies markup in integer minor units', () => {
    expect(decimalToMinor('12.3')).toBe(1230);
    expect(applyMarkup(1230, 250)).toBe(1261);
    expect(() => decimalToMinor('12.345')).toThrow(ZJMFClientError);
  });

  it('normalizes an upstream base URL and rejects embedded credentials', () => {
    expect(normalizeBaseUrl('https://billing.example/base/')).toBe('https://billing.example/base/');
    expect(() => normalizeBaseUrl('https://user:pass@billing.example')).toThrow(ZJMFClientError);
    expect(() => normalizeBaseUrl('https://[::1]')).toThrow(ZJMFClientError);
    expect(isUnsafeIpAddress('10.0.0.1')).toBe(true);
    expect(isUnsafeIpAddress('fd00::1')).toBe(true);
    expect(isUnsafeIpAddress('1.1.1.1')).toBe(false);
  });

  it('flags IPv4-mapped IPv6 bypasses and reserved ranges (audit M-1)', () => {
    expect(isUnsafeIpAddress('::ffff:7f00:1')).toBe(true);
    expect(isUnsafeIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isUnsafeIpAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isUnsafeIpAddress('100.64.0.1')).toBe(true);
    expect(isUnsafeIpAddress('198.18.0.1')).toBe(true);
    expect(isUnsafeIpAddress('224.0.0.1')).toBe(true);
    expect(isUnsafeIpAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('ZJMF service provisioning', () => {
  function clientFor(fetchMock: typeof fetch, protocol: 'finance' | 'v10' = 'finance'): ZJMFClient {
    return new ZJMFClient(
      { id: 'up', baseUrl: 'https://billing.example/', protocol, username: 'u', password: 'p' },
      fetchMock,
    );
  }

  it('creates a finance service via the cart chain and extracts the host id', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      calls.push(path);
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/cart/clear') return json({ status: 200, data: {} });
      if (path === '/cart/add_to_shop') return json({ status: 200, data: {} });
      if (path === '/cart/settle') {
        return json({ status: 200, data: { hostid: 42, invoiceid: 7001 } });
      }
      if (path === '/apply_credit') return json({ status: 1001, data: {} });
      return json({ status: 200, data: {} });
    });
    const client = clientFor(fetchMock);
    const result = await client.createService('prod-1', {
      cycle: 'monthly',
      selections: { '3201217': 15038165 },
    });

    expect(calls).toEqual([
      '/zjmf_api_login',
      '/cart/clear',
      '/cart/add_to_shop',
      '/cart/settle',
      '/apply_credit',
    ]);
    expect(result.providerServiceId).toBe('42');
    expect(result.runtime).toMatchObject({
      paid: true,
      invoiceId: '7001',
      billingCycle: 'monthly',
    });
    const addCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/cart/add_to_shop',
    );
    expect(addCall?.[1]?.body?.toString()).toContain('configoption%5B3201217%5D=15038165');
    expect(addCall?.[1]?.body?.toString()).toContain('billingcycle=monthly');
  });

  it('creates a V10 service via the api endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'v10' } });
      if (path === '/api/v1/service') {
        return json({
          status: 200,
          data: { service_id: 'svc-1', ip: '203.0.113.10', cpu: '2', memory: '4096' },
        });
      }
      return json({ status: 200, data: {} });
    });
    const result = await clientFor(fetchMock, 'v10').createService('prod-1');
    expect(result.providerServiceId).toBe('svc-1');
    expect(result.runtime.specs).toMatchObject({ cpu: '2', memory: '4096' });
  });

  it('fetches finance service detail via host header with ip and status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/header') {
        return json({
          status: 200,
          data: { host_data: { id: 42, ip: '203.0.113.10', username: 'root', status: 'Active' } },
        });
      }
      return json({ status: 200, data: {} });
    });
    const detail = await clientFor(fetchMock).getService('42');
    expect(detail).toMatchObject({ ip: '203.0.113.10', username: 'root', status: 'Active' });
  });

  it('maps finance dedicatedip/domainstatus and enriches specs from host list', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/header') {
        return json({
          status: 200,
          data: {
            host_data: {
              id: 30463,
              dedicatedip: '86.53.111.148',
              username: 'root',
              password: 'secret',
              status: 'Paid',
              domainstatus: 'Active',
              domainstatus_desc: '已激活',
              os: 'Debian-13',
            },
          },
        });
      }
      if (path === '/host/list') {
        return json({
          status: 200,
          data: {
            list: [
              {
                id: 30463,
                cpu: '1核',
                memory: '1G',
                system_disk_size: '15G',
                bw: '100Mbps',
                area: 'DE^德国 法兰克福',
              },
            ],
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const detail = await clientFor(fetchMock).getService('30463');
    // 真实运行状态以 domainstatus 为准，status（Paid）是账单状态。
    expect(detail).toMatchObject({
      ip: '86.53.111.148',
      username: 'root',
      password: 'secret',
      status: 'Active',
      statusLabel: '已激活',
      specs: {
        cpu: '1核',
        memory: '1G',
        disk: '15G',
        bandwidth: '100Mbps',
        region: '德国 法兰克福',
        os: 'Debian-13',
      },
    });
  });

  it('normalizes finance monitor payloads into metric series', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/monitor') {
        return json({
          status: 200,
          data: {
            cpu_usage: [
              { t: 1700000000000, v: 12.5 },
              { t: 1700000060000, v: 13.2 },
            ],
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const metrics = await clientFor(fetchMock).getServiceMetrics('42');
    const cpu = metrics.find((m) => m.id === 'cpu_usage');
    expect(cpu?.points).toHaveLength(2);
    expect(cpu?.points[0]).toMatchObject({ t: 1700000000000, v: 12.5 });
  });

  it('posts a finance action to the provision endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/provision/default') return json({ status: 200, data: {} });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).runServiceAction('42', 'reboot');
    const actionCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/provision/default',
    );
    expect(actionCall?.[1]?.body?.toString()).toContain('func=reboot');
    expect(actionCall?.[1]?.body?.toString()).toContain('is_api=1');
  });
});
