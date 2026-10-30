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

describe('provisioning request safety', () => {
  function cancelledFixture(patch: Record<string, unknown> = {}, accounts: unknown = []) {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/get_invoices_detail')
        return json({
          status: 200,
          data: {
            detail: {
              id: 7001,
              status: 'Cancelled',
              paid_time: 0,
              credit: '0.00',
              use_credit_limit: 0,
              subtotal: '47.88',
              total: '47.88',
              ...patch,
            },
            accounts,
            invoice_items: [{ type: 'host', rel_id: 42 }],
          },
        });
      return json({ status: 200, data: { host_data: { domainstatus: 'Cancelled' } } });
    });
    return {
      client: new ZJMFClient(
        {
          id: 'up',
          baseUrl: 'https://billing.example/',
          protocol: 'finance',
          username: 'u',
          password: 'p',
        },
        fetcher,
      ),
      fetcher,
    };
  }
  it('verifies cancelled invoices using only account-scoped GET requests', async () => {
    const { client, fetcher } = cancelledFixture();
    await client.verifyCancelledInvoice('7001', ['42']);
    expect(
      fetcher.mock.calls
        .filter((call) => new URL(String(call[0])).pathname !== '/zjmf_api_login')
        .every((call) => call[1]?.method === 'GET'),
    ).toBe(true);
  });
  it.each([
    { status: 'Paid' },
    { status: 'Unpaid' },
    { paid_time: 1800000000 },
    { credit: '1.00' },
    { use_credit_limit: 1 },
    { total: '46.88' },
    { id: 999 },
    { credit: null },
    { subtotal: undefined },
  ])('rejects incomplete or paid original invoice evidence: %j', async (patch) => {
    await expect(
      cancelledFixture(patch).client.verifyCancelledInvoice('7001', ['42']),
    ).rejects.toThrow(/禁止重开/);
  });
  it.each([[{ amount_in: '1.00' }], null])(
    'rejects financial history or missing transaction evidence',
    async (accounts) => {
      await expect(
        cancelledFixture({}, accounts).client.verifyCancelledInvoice('7001', ['42']),
      ).rejects.toThrow(/禁止重开/);
    },
  );
  it('rejects invoices belonging to a different service', async () => {
    await expect(cancelledFixture().client.verifyCancelledInvoice('7001', ['43'])).rejects.toThrow(
      /不匹配/,
    );
  });
  it('reuses the invoice returned by downstream cart recovery without adding or settling again', async () => {
    const { client, fetcher, requests } = fixture();
    fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: String(init?.body ?? '') });
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/cart/clear') return json({ status: 200, hostid: 42, invoiceid: 7001 });
      return json({ status: 1001 });
    });
    await client.createService('4661', {
      downstream: { id: '12345', token: 'a'.repeat(32), url: 'https://panel.example/' },
    });
    expect(
      requests
        .map((request) => request.path)
        // 付款后会用主机列表做只读复核（确认实例身份），不属于资金操作。
        .filter((path) => path !== '/host/list' && path !== '/host/header'),
    ).toEqual(['/zjmf_api_login', '/cart/clear', '/apply_credit']);
    expect(requests[1]?.body).toContain('downstream_id=12345');
    expect(requests[2]?.body).toContain('is_api=1');
  });
  it('rejects batch submission before sending any upstream request', async () => {
    const { client, requests } = fixture();
    await expect(client.createService('4661', { quantity: 2 })).rejects.toThrow(/逐台/);
    expect(requests).toHaveLength(0);
  });
  it('keeps malformed payment responses unknown rather than enabling another debit', async () => {
    const { client } = fixture({ data: {} });
    expect((await client.createService('4661')).runtime.paymentState).toBe('PAYMENT_UNKNOWN');
  });
  it('does not accept a success-shaped payload delivered with HTTP 500', async () => {
    const { client, fetcher } = fixture();
    fetcher.mockImplementation(async (input) =>
      new URL(String(input)).pathname === '/zjmf_api_login'
        ? json({ status: 200, jwt: 'jwt' })
        : new Response(JSON.stringify({ status: 1001 }), { status: 500 }),
    );
    expect(await client.payServiceInvoice('original')).toEqual({
      paid: false,
      paymentState: 'PAYMENT_UNKNOWN',
    });
  });
  it('preserves every unexpected host ID and never pays an unexpected batch', async () => {
    const { client, fetcher, requests } = fixture();
    fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: String(init?.body ?? '') });
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/cart/settle')
        return json({ status: 200, data: { hostid: [42, 43], invoiceid: 7001 } });
      return json({ status: 200 });
    });
    const checkpoint = vi.fn(async () => {});
    await expect(client.createService('4661', { checkpoint })).rejects.toThrow(/非预期数量/);
    expect(checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({
          providerServiceIds: [42, 43],
          paymentState: 'REQUIRES_RECONCILIATION',
        }),
      }),
    );
    expect(requests.some((request) => request.path === '/apply_credit')).toBe(false);
  });
  it.each(['insufficient', 'timeout'])(
    'never falls back to partial payment on renewal: %s',
    async (failure) => {
      const { client, fetcher, requests } = fixture();
      fetcher.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, body: String(init?.body ?? '') });
        if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
        if (path === '/host/renew') return json({ status: 200, data: { invoiceid: 7001 } });
        if (failure === 'timeout') throw new DOMException('timeout', 'TimeoutError');
        return json({ status: 200 });
      });
      await expect(client.renewService('42')).rejects.toThrow(/原上游账单/);
      expect(requests.filter((request) => request.path === '/apply_credit')).toHaveLength(1);
      expect(requests.find((request) => request.path === '/apply_credit')?.body).toContain(
        'enough=1',
      );
    },
  );
  function fixture(payment: unknown = { status: 1001 }) {
    const requests: Array<{ path: string; body: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: String(init?.body ?? '') });
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'secret-jwt' });
      if (path === '/cart/settle')
        return json({ status: 200, data: { hostid: 42, invoiceid: 7001 } });
      if (path === '/apply_credit') return json(payment);
      return json({ status: 200, data: {} });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'secret-user',
        password: 'secret-password',
      },
      fetcher,
    );
    return { client, fetcher, requests };
  }
  it('frames empty POST forms and persists the instance/invoice before payment', async () => {
    const { client, requests } = fixture();
    const saved: string[] = [];
    const result = await client.createService('4661', {
      checkpoint: async (service) => {
        expect(service.providerServiceId).toBe('42');
        expect(service.runtime.invoiceId).toBe('7001');
        expect(requests.some((request) => request.path === '/apply_credit')).toBe(false);
        saved.push(String(service.runtime.paymentState));
      },
    });
    expect(saved).toEqual(['ORDER_CREATED', 'PAYMENT_IN_FLIGHT']);
    expect(
      requests
        .filter((request) => ['/cart/clear', '/cart/settle'].includes(request.path))
        .map((request) => request.body),
    ).toEqual(['&', '&']);
    expect(result.runtime.paid).toBe(true);
  });
  it('does not treat finance 200 as paid or attempt partial payment', async () => {
    const { client, requests } = fixture({ status: 200 });
    const result = await client.createService('4661');
    expect(result.runtime).toMatchObject({
      paid: false,
      paymentState: 'PAYMENT_REQUIRED',
      status: 'PENDING_INVOICE',
    });
    expect(requests.filter((request) => request.path === '/apply_credit')).toHaveLength(1);
    expect(requests.find((request) => request.path === '/apply_credit')?.body).toContain(
      'enough=1',
    );
  });
  it('does not pay when durable checkpoint storage fails', async () => {
    const { client, requests } = fixture();
    await expect(
      client.createService('4661', {
        checkpoint: async () => {
          throw new Error('disk unavailable');
        },
      }),
    ).rejects.toThrow('disk unavailable');
    expect(requests.some((request) => request.path === '/apply_credit')).toBe(false);
  });
  it('stops after failed cart clear instead of adding into an unknown cart', async () => {
    const { client, fetcher, requests } = fixture();
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: '' });
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      throw new TypeError('secret transport payload');
    });
    await expect(client.createService('4661')).rejects.toThrow(
      /POST \/cart\/clear TRANSPORT_ERROR/,
    );
    expect(requests.map((request) => request.path)).toEqual(['/zjmf_api_login', '/cart/clear']);
  });
  it('never resends a mutating request on a business authentication error', async () => {
    const { client, fetcher, requests } = fixture();
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: '' });
      return path === '/zjmf_api_login'
        ? json({ status: 200, jwt: 'jwt' })
        : json({ status: 401, msg: 'expired' });
    });
    await expect(client.createService('4661')).rejects.toThrow();
    expect(requests.map((request) => request.path)).toEqual(['/zjmf_api_login', '/cart/clear']);
  });
  it('retains a payment timeout as unknown and sends no fallback debit', async () => {
    const { client, fetcher, requests } = fixture();
    fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: String(init?.body ?? '') });
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/cart/settle')
        return json({ status: 200, data: { hostid: 42, invoiceid: 7001 } });
      if (path === '/apply_credit')
        throw new DOMException('secret-provider-message', 'TimeoutError');
      return json({ status: 200 });
    });
    const result = await client.createService('4661');
    expect(result.runtime).toMatchObject({
      invoiceId: '7001',
      paid: false,
      paymentState: 'PAYMENT_UNKNOWN',
    });
    expect(requests.filter((request) => request.path === '/apply_credit')).toHaveLength(1);
  });
});

describe('ZJMFClient', () => {
  it.each(['regdate', 'create_time', 'active_time'])(
    'reads upstream opening date from %s',
    async (key) => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        if (new URL(input.toString()).pathname === '/zjmf_api_login')
          return json({ status: 200, jwt: 'token' });
        return json({ status: 200, data: { count: 1, list: [{ id: 42, [key]: '1800000000' }] } });
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
      expect((await client.listHosts())[0]?.openedAt).toBe('2027-01-15T08:00:00.000Z');
    },
  );
  it('reads expiry from finance instance details when the list omits it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'token' });
      if (path === '/host/header')
        return json({
          status: 200,
          data: { host_data: { id: 42, nextduedate: '1800000000', regdate: '1700000000' } },
        });
      return json({ status: 200, data: { list: [{ id: 42 }] } });
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
    expect(await client.getService('42')).toMatchObject({
      expiresAt: '2027-01-15T08:00:00.000Z',
      openedAt: '2023-11-14T22:13:20.000Z',
    });
  });
  it.each([
    ['nextduedate', 1800000000, '2027-01-15T08:00:00.000Z'],
    ['nextduedate', '1800000000', '2027-01-15T08:00:00.000Z'],
    ['due_time', 1800000000000, '2027-01-15T08:00:00.000Z'],
    ['expire_at', '2027-01-15', '2027-01-15'],
    ['expires_at', '2027-01-15T08:00:00Z', '2027-01-15T08:00:00Z'],
    ['nextduedate', 'invalid', null],
    ['nextduedate', 0, null],
    ['nextduedate', '0000-00-00', null],
  ])('normalizes upstream expiry %s=%s', async (key, value, expected) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (new URL(input.toString()).pathname === '/zjmf_api_login')
        return json({ status: 200, jwt: 'token' });
      return json({ status: 200, data: { count: 1, list: [{ id: 42, [key]: value }] } });
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
    expect((await client.listHosts())[0]?.expiresAt).toBe(expected);
  });
  it('loads all host pages and retains upstream product identity', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'token' });
      const page = Number(url.searchParams.get('page'));
      return json({
        status: 200,
        data: {
          count: 51,
          list: Array.from({ length: page === 1 ? 50 : 1 }, (_, i) => ({
            id: (page - 1) * 50 + i + 1,
            product_id: 7,
            name: 'Cloud',
            status: 'Active',
          })),
        },
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
    const hosts = await client.listHosts();
    expect(hosts).toHaveLength(51);
    expect(hosts[50]).toMatchObject({ id: '51', productId: '7' });
  });
  it('reports rejected upstream credentials as a gateway failure with a stable code', async () => {
    const client = new ZJMFClient(
      {
        id: 'legacy',
        baseUrl: 'https://finance.example',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      vi.fn<typeof fetch>(async () => json({ status: 401, msg: '鉴权失败' })),
    );

    const error = await client.listProducts().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ZJMFClientError);
    expect(error).toMatchObject({
      status: 502,
      code: 'zjmf.client.credentials_rejected',
      message: '上游凭证被拒绝',
    });
  });

  it('uses the legacy V1 JWT field and product routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'legacy-jwt' });
      if (path === '/api/product/list') {
        return json({
          status: 200,
          data: {
            currency_code: 'CNY',
            list: [{ id: 7, name: 'VPS', price: '9.90' }],
          },
        });
      }
      return json({
        status: 200,
        data: {
          product: { id: 7, name: 'VPS', description: '1C1G', price: '9.90' },
        },
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
        : json({
            status: 200,
            data: { list: [{ id: 'a', name: 'Cloud', sale_price: '12.34' }] },
          });
    });
    const client = new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example/',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );

    const listed = await client.listProducts();

    expect(listed.products[0]).toMatchObject({ id: 'a', price: '12.34' });
    expect(loginCount).toBe(2);
    expect(productCount).toBe(2);
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer v10-2',
    });
  });
});

describe('ZJMF failure vs empty distinction (handoff #2)', () => {
  function clientFor(
    fetchMock: typeof fetch,
    protocol: 'finance' | 'v10' = 'finance',
    allowUnverifiedV10Routes = false,
  ): ZJMFClient {
    return new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol,
        username: 'u',
        password: 'p',
        allowUnverifiedV10Routes,
      },
      fetchMock,
    );
  }

  it('V1: listServiceResources throws on HTTP 500 instead of returning []', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return new Response('boom', { status: 500 });
    });
    await expect(
      clientFor(fetchMock).listServiceResources('42', 'snapshot'),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it('V2: listServiceResources throws when auth keeps returning 401', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return json({ status: 401, msg: 'unauthorized' });
    });
    await expect(
      clientFor(fetchMock).listServiceResources('42', 'snapshot'),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it('V3: listServiceResources returns [] only on a successful empty set', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return json({ status: 200, data: { list: [] } });
    });
    await expect(clientFor(fetchMock).listServiceResources('42', 'snapshot')).resolves.toEqual([]);
  });

  it('V4: finance 没有监控端点 → 返回空集且不发请求（实测 /host/monitor 404）', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return new Response('boom', { status: 500 });
    });
    await expect(clientFor(fetchMock).getServiceMetrics('42')).resolves.toEqual([]);
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain('/host/monitor');
  });

  it('V5: calculateChangePrice throws on HTTP 500 instead of null', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return new Response('boom', { status: 500 });
    });
    await expect(
      clientFor(fetchMock).calculateChangePrice('42', {
        selections: { '1': 2 },
      }),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it('V6: changeOwner 在上游无自助转移端点时返回 null 且不发请求', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      return new Response('boom', { status: 500 });
    });
    await expect(clientFor(fetchMock, 'v10', true).changeOwner('svc-1', 'u-2')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('V7: V10 子资源走 console/v1 真实路由（快照列表）', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-1') return json({ status: 200, data: { id: 1 } });
      if (path === '/console/v1/mf_cloud/svc-1/snapshot')
        return json({
          status: 200,
          data: { list: [{ id: 7, name: 'snap-a', status: 1 }] },
        });
      return new Response('boom', { status: 500 });
    });
    const rows = await clientFor(fetchMock, 'v10').listServiceResources('svc-1', 'snapshot');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('7');
    const paths = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(paths).toContain('/console/v1/mf_cloud/svc-1/snapshot');
    // 旧的虚构路径不得再出现。
    expect(paths.some((path) => path.startsWith('/api/v1/service'))).toBe(false);
  });

  it('V7b: 真正未取证的能力（换商品）仍报 unsupported', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ status: 200, data: {} }));
    const error = await clientFor(fetchMock, 'v10')
      .changeProduct('svc-1', 'prod-2')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZJMFClientError);
    expect((error as ZJMFClientError).code).toBe('zjmf.client.unsupported');
  });

  it('V7c: 未开启实验开关时换商品不发任何请求', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ status: 200, data: {} }));
    await expect(
      clientFor(fetchMock, 'v10').changeProduct('svc-1', 'prod-2'),
    ).rejects.toBeInstanceOf(ZJMFClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('V8: finance branch is unaffected by the V10 unsupported guard', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return json({ status: 200, data: { list: [{ id: 1, hid: 42 }] } });
    });
    // 财务协议不支持服务子资源（fail-closed，实测上游 500），且不触发「V10 未取证」守卫。
    await expect(clientFor(fetchMock, 'finance').supportsServiceResources('42')).resolves.toBe(
      false,
    );
    await expect(clientFor(fetchMock, 'finance').getServiceMetrics('42')).resolves.toEqual([]);
  });

  it('V7b: experimental switch restores the unverified V10 route', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      return json({ status: 200, data: { list: [{ id: 1, name: 'snap' }] } });
    });
    const rows = await clientFor(fetchMock, 'v10', true).listServiceResources('svc-1', 'snapshot');
    expect(rows).toEqual([{ id: '1', fields: { name: 'snap' } }]);
  });
});

describe('ZJMF value normalization', () => {
  it('quotes Finance V1 with the selected cycle and flat configoption fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      const form = init?.body as URLSearchParams;
      expect(form.get('pid')).toBe('4661');
      expect(form.get('billingcycle')).toBe('monthly');
      expect(form.get('configoption[3395986]')).toBe('4');
      return json({
        status: 200,
        products: {
          // This Finance V1 variant returns the config-only amount here; the
          // selected package base is still present separately.
          sale_total: '0.96',
          product_sale_price: '72.00',
          child: [{ option_name: 'CPU', suboption_name: '4核', suboption_price: '0' }],
        },
      });
    });
    const quote = await new ZJMFClient(
      {
        id: 'finance',
        baseUrl: 'https://finance.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    ).calculatePrice('4661', {
      cycle: 'monthly',
      selections: { '3395986': '4' },
    });

    expect(quote).toMatchObject({ price: 7200, summary: 'CPU:4核' });
  });

  it('converts prices exactly and applies markup in integer minor units', () => {
    expect(decimalToMinor('12.3')).toBe(1230);
    expect(applyMarkup(1230, 250)).toBe(1261);
    // 0 元是合法金额（0 元变配/免费商品），不能当成「超出范围」抛错。
    expect(applyMarkup(0, 250)).toBe(0);
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
  function clientFor(
    fetchMock: typeof fetch,
    protocol: 'finance' | 'v10' = 'finance',
    allowUnverifiedV10Routes = false,
  ): ZJMFClient {
    return new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol,
        username: 'u',
        password: 'p',
        allowUnverifiedV10Routes,
      },
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

    expect(calls.filter((path) => path !== '/host/list' && path !== '/host/header')).toEqual([
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

  // 证据：`app/common/logic/ResModuleLogic.php:382-435` 上游代理自己的下单链路。
  it('creates a V10 service through the console cart flow', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'v10' } });
      if (path === '/console/v1/cart') return json({ status: 200, data: {} });
      if (path === '/console/v1/cart/settle')
        return json({
          status: 200,
          data: { host_ids: [101], order_id: '8001', amount: '0.00' },
        });
      if (path === '/console/v1/mf_cloud/101')
        return json({
          status: 200,
          data: { id: 101, ip: '203.0.113.10', username: 'root', password: ' pw ' },
        });
      return json({ status: 200, data: {} });
    });
    const result = await clientFor(fetchMock, 'v10', true).createService('prod-1', {
      cycle: 'monthly',
      selections: { '3201217': 15038165 },
    });
    expect(result.providerServiceId).toBe('101');
    expect(result.credentials).toMatchObject({ username: 'root' });
    const paths = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(paths).toContain('/console/v1/cart');
    expect(paths).toContain('/console/v1/cart/settle');
    const cartCall = fetchMock.mock.calls.find(
      (call) =>
        new URL(call[0].toString()).pathname === '/console/v1/cart' && call[1]?.method === 'POST',
    );
    const body = cartCall?.[1]?.body?.toString() ?? '';
    expect(body).toContain('product_id=prod-1');
    // PHP 风格嵌套编码
    expect(body).toContain('config_options%5Bconfigoption%5D%5B3201217%5D=15038165');
    expect(body).toContain('config_options%5Bcycle%5D=monthly');
  });

  it('fetches finance service detail via host header with ip and status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/header') {
        return json({
          status: 200,
          data: {
            host_data: {
              id: 42,
              ip: '203.0.113.10',
              username: 'root',
              status: 'Active',
            },
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const detail = await clientFor(fetchMock).getService('42');
    expect(detail).toMatchObject({
      ip: '203.0.113.10',
      username: 'root',
      status: 'Active',
    });
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

  it('reads finance host detail from the member host list when header reports no product', async () => {
    // 真实上游（moebun）实测：/host/header?host_id=N 一律回「未找到该产品」，
    // 而 /host/list 才是权威数据源（状态/IP/规格/到期都在里面）。
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/header') return json({ status: 400, message: '未找到该产品' });
      if (path === '/host/list')
        return json({
          status: 200,
          data: {
            count: 1,
            list: [
              {
                id: 33363,
                domain: 'S93z7tkBNkRxq',
                domainstatus: 'Active',
                domainstatus_desc: '已激活',
                dedicatedip: '156.233.230.86',
                regdate: 1793252404,
                nextduedate: 1795930812,
                amount: '47.88',
                billingcycle: 'monthly',
                os: 'Debian^Debian13-x86',
                productname: '香港EPYC-4H8G',
                cpu: '4核',
                memory: '8G',
                system_disk_size: '60GB NVME',
                bw: '35Mbps',
                area: 'HK^香港EPYC',
                invoice_id: 875800,
              },
            ],
          },
        });
      return json({ status: 200, data: {} });
    });
    const detail = await clientFor(fetchMock).getService('33363');
    expect(detail).toMatchObject({
      providerServiceId: '33363',
      ip: '156.233.230.86',
      status: 'Active',
      statusLabel: '已激活',
      expiresAt: '2026-11-29T05:40:12.000Z',
      openedAt: '2026-10-29T05:40:04.000Z',
      cycle: 'monthly',
      specs: {
        cpu: '4核',
        memory: '8G',
        disk: '60GB NVME',
        bandwidth: '35Mbps',
        region: '香港EPYC',
      },
    });
  });
  it('maps a placeholder host id to the real host created by payment', async () => {
    // 实测：账单 875797 付款后真实主机是 33363，而账单 items[].rel_id 指向 33360（不存在）。
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/list')
        return json({
          status: 200,
          data: {
            count: 2,
            list: [
              { id: 30001, invoice_id: 500, regdate: 1700000000 },
              { id: 33363, invoice_id: 875800, regdate: 1793252404 },
            ],
          },
        });
      return json({ status: 200, data: {} });
    });
    const client = clientFor(fetchMock);
    // 直接按账单号：付款换了新号，查不到 → null（绝不猜）
    expect(await client.findHostForInvoice('875797')).toBeNull();
    // 按账单号精确命中
    expect((await client.findHostForInvoice('875800'))?.id).toBe('33363');
    // 时间窗兜底：只有 33363 在本次尝试之后创建
    const resolved = await client.resolveHostForAttempt({
      invoiceId: '875797',
      sinceMs: 1793252404 * 1000,
    });
    expect(resolved?.id).toBe('33363');
  });
  it('finance 不伪造监控曲线：只返回空集', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return json({ status: 200, data: {} });
    });
    await expect(clientFor(fetchMock).getServiceMetrics('42')).resolves.toEqual([]);
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

  it('forwards action params and returns the upstream payload (finance)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/provision/default') {
        return json({ status: 200, data: { password: 'S3cretPass!' } });
      }
      return json({ status: 200, data: {} });
    });
    const result = await clientFor(fetchMock).runServiceAction('42', 'reset_password', {
      password: 'S3cretPass!',
    });
    const actionCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/provision/default',
    );
    const body = actionCall?.[1]?.body?.toString() ?? '';
    // 财务版重置密码的 func 是 `crack_pass`（`reset_password` 会被上游回
    // 406「不支持的方法」）；证据 mf_finance / mf_finance_common 的 $postData。
    expect(body).toContain('func=crack_pass');
    expect(body).toContain('password=S3cretPass%21');
    expect(result).toMatchObject({ data: { password: 'S3cretPass!' } });
  });

  // 证据：`mf_cloud/route.php:94-102` 每个动作一个端点。
  it('routes V10 actions to the real console endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-9') return json({ status: 200, data: { id: 9 } });
      return json({
        status: 200,
        data: { url: 'https://console.example/vnc', vnc_pass: 'p' },
      });
    });
    const client = new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    const result = await client.runServiceAction('svc-9', 'reinstall', {
      os: 'ubuntu-22.04',
    });
    const actionCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/console/v1/mf_cloud/svc-9/reinstall',
    );
    expect(actionCall).toBeDefined();
    const body = actionCall?.[1]?.body?.toString() ?? '';
    expect(body).toContain('os=ubuntu-22.04');
    expect(result).toMatchObject({
      data: { url: 'https://console.example/vnc' },
    });
    // 旧虚构路径不得再出现。
    const paths = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(paths.some((path) => path.includes('/api/v1/service'))).toBe(false);
  });

  it('VNC 动作带上 more=1 并落在控制台路由上', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-9') return json({ status: 200, data: { id: 9 } });
      return json({
        status: 200,
        data: { vnc_url: 'https://vnc.example/x', vnc_pass: 'p' },
      });
    });
    const client = new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    await client.runServiceAction('svc-9', 'vnc');
    const call = fetchMock.mock.calls.find(
      (entry) => new URL(entry[0].toString()).pathname === '/console/v1/mf_cloud/svc-9/vnc',
    );
    expect(call).toBeDefined();
    expect(new URL(call![0].toString()).search).toBe('?more=1');
  });

  it('does not let caller params override reserved action fields (finance)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).runServiceAction('42', 'power_off', {
      func: 'terminate',
      id: '999',
      is_api: '0',
    });
    const body =
      fetchMock.mock.calls
        .find((call) => new URL(call[0].toString()).pathname === '/provision/default')?.[1]
        ?.body?.toString() ?? '';
    // 保留字段以客户端为准：func=off、id=42、is_api=1，参数不得覆盖。
    expect(body).toContain('func=off');
    expect(body).toContain('id=42');
    expect(body).toContain('is_api=1');
    expect(body).not.toContain('func=terminate');
  });

  it('renews a finance service via host/renew and pays the invoice', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/host/renew') return json({ status: 200, data: { invoiceid: 8801 } });
      if (path === '/apply_credit') return json({ status: 1001, data: {} });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).renewService('42', { cycle: 'monthly' });
    const renew = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/host/renew',
    );
    expect(renew?.[1]?.body?.toString()).toContain('hostid=42');
    expect(renew?.[1]?.body?.toString()).toContain('billingcycles=monthly');
    const credit = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/apply_credit',
    );
    expect(credit?.[1]?.body?.toString()).toContain('invoiceid=8801');
  });

  it('changes a finance package via upgrade config chain', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/upgrade/checkout_config_upgrade') {
        return json({ status: 200, data: { invoiceid: 9001 } });
      }
      if (path === '/apply_credit') return json({ status: 1001 });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).changePackage('42', {
      selections: { '3201': 777 },
    });
    const post = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/upgrade/upgrade_config_post',
    );
    const body = post?.[1]?.body?.toString() ?? '';
    expect(body).toContain('hid=42');
    expect(body).toContain('configoption%5B3201%5D=777');
  });

  it('quotes a finance change price from the upgrade config page', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/upgrade/upgrade_config_page') {
        return json({
          status: 200,
          data: {
            price_difference: '12.30',
            preview: [{ name: 'CPU', value: '2核=>4核', price: '10.00' }],
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const quote = await clientFor(fetchMock).calculateChangePrice('42', {
      selections: { '3201': 777 },
    });
    expect(quote?.price).toBe(1230);
    expect(quote?.breakdown?.[0]).toMatchObject({
      label: 'CPU',
      value: '2核=>4核',
      price: 1000,
    });
  });

  it('lists and creates finance service resources via provision/custom', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/provision/custom/content') {
        return json({
          status: 200,
          data: { list: [{ id: 9, name: 'snap-1' }] },
        });
      }
      return json({ status: 200, data: {} });
    });
    const rows = await clientFor(fetchMock).listServiceResources('42', 'snapshot');
    expect(rows).toEqual([{ id: '9', fields: { name: 'snap-1' } }]);

    await clientFor(fetchMock).createServiceResource('42', 'snapshot', {
      disk_id: '5',
      name: 'snap-2',
    });
    const create = fetchMock.mock.calls.find(
      (call) =>
        new URL(call[0].toString()).pathname === '/provision/custom/42' &&
        call[1]?.body?.toString().includes('func=createSnap'),
    );
    expect(create?.[1]?.body?.toString()).toContain('disk_id=5');
  });

  it('runs a finance resource action with the mapped func', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).runResourceAction('42', 'snapshot', '9', 'restore');
    const call = fetchMock.mock.calls.find(
      (candidate) => new URL(candidate[0].toString()).pathname === '/provision/custom/42',
    );
    const body = call?.[1]?.body?.toString() ?? '';
    expect(body).toContain('func=restoreSnap');
    expect(body).toContain('id=9');
  });
});

describe('ZJMF config matrix mapping', () => {
  function clientFor(fetchMock: typeof fetch): ZJMFClient {
    return new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
  }

  it('maps upstream options to grouped, price-per-cycle choices', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (path === '/cart/set_config') {
        return json({
          status: 200,
          product: {
            cycle: [
              {
                billingcycle: 'monthly',
                billingcycle_zh: '月付',
                product_price: '60.00',
              },
              {
                billingcycle: 'yearly',
                billingcycle_zh: '年付',
                product_price: '600.00',
              },
            ],
          },
          option: [
            {
              id: 320,
              option_name: 'CPU',
              option_type: 1,
              sub: [
                {
                  id: 3201,
                  option_name: '2 核',
                  pricing: { monthly: 10, yearly: 100 },
                },
                {
                  id: 3202,
                  option_name: '4 核',
                  pricing: { monthly: 20, yearly: 200 },
                },
              ],
            },
            {
              id: 321,
              option_name: 'Windows 镜像',
              option_type: 5,
              configoption_id: 320,
              configoption_sub_id: 3202,
              sub: { win: { child: [{ id: 5001, version: 'Windows 2022' }] } },
            },
          ],
        });
      }
      return json({ status: 200, data: {} });
    });
    const config = await clientFor(fetchMock).getConfig('prod-1');
    expect(config?.cycles).toHaveLength(2);
    const cpu = config?.options.find((option) => option.id === '320');
    expect(cpu?.group).toBe('规格');
    expect(cpu?.choices[0]).toMatchObject({
      id: '3201',
      prices: { monthly: 1000, yearly: 10000 },
    });
    const image = config?.options.find((option) => option.id === '321');
    expect(image?.group).toBe('镜像');
    expect(image?.visibleWhen).toEqual({ field: '320', equals: '3202' });
  });
});

describe('ZJMF V10 console 契约补充', () => {
  const v10 = (fetchMock: typeof fetch) =>
    new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );

  it('家族自动探测：mf_cloud 404 后回退到 remf_cloud', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-2') return json({ status: 404, msg: '模块不存在' });
      if (path === '/console/v1/remf_cloud/svc-2')
        return json({ status: 200, data: { id: 2, ip: '198.51.100.7' } });
      if (path === '/console/v1/host/svc-2')
        return json({ status: 200, data: { host: { status: 'Active' } } });
      return json({ status: 400, msg: 'module not found' });
    });
    const detail = await v10(fetchMock).getService('svc-2');
    expect(detail['ip']).toBe('198.51.100.7');
    const paths = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(paths).toContain('/console/v1/remf_cloud/svc-2');
  });

  it('家族探测不会把 HTTP 200 + status=400 误判为命中', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-3')
        return json({ status: 400, msg: '实例不存在', data: {} });
      if (path === '/console/v1/remf_cloud/svc-3')
        return json({ status: 200, data: { id: 3, ip: '198.51.100.8' } });
      return json({ status: 200, data: {} });
    });
    const detail = await v10(fetchMock).getService('svc-3');
    expect(detail['ip']).toBe('198.51.100.8');
  });

  it('续费 Unpaid 时按 credit → pay 走余额支付', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/host/svc-4/renew')
        return json({ status: 200, code: 'Unpaid', data: { id: 5001 } });
      if (path === '/console/v1/credit') return json({ status: 200, data: { id: 5001 } });
      if (path === '/console/v1/pay') return json({ status: 200, data: { status: 200 } });
      return json({ status: 400, msg: 'unexpected' });
    });
    const result = await v10(fetchMock).renewService('svc-4', {
      cycle: 'monthly',
    });
    expect(result).toBeTruthy();
    const calls = fetchMock.mock.calls.map((call) => ({
      path: new URL(call[0].toString()).pathname,
      body: call[1]?.body?.toString() ?? '',
    }));
    expect(calls.some((call) => call.path === '/console/v1/credit')).toBe(true);
    const pay = calls.find((call) => call.path === '/console/v1/pay');
    expect(pay?.body).toContain('gateway=credit');
    expect(pay?.body).toContain('id=5001');
  });

  it('due_time（Unix 秒）转成 ISO 到期时间', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-5')
        return json({ status: 200, data: { id: 5, due_time: 1767225600 } });
      if (path === '/console/v1/host/svc-5')
        return json({
          status: 200,
          data: { host: { status: 'Active', due_time: 1767225600 } },
        });
      return json({ status: 200, data: {} });
    });
    const detail = await v10(fetchMock).getService('svc-5');
    expect(detail['expiresAt']).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('ZJMF V10 家族差异', () => {
  const v10 = (fetchMock: typeof fetch) =>
    new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );

  it('idcsmart_common 走 provision/:func（无 vnc）', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-7') return json({ status: 200, data: {} });
      if (path === '/console/v1/remf_cloud/svc-7') return json({ status: 200, data: {} });
      if (path === '/console/v1/mf_dcim/svc-7') return json({ status: 200, data: {} });
      if (path === '/console/v1/idcsmart_common/host/svc-7/configoption')
        return json({ status: 200, data: { configoption: [{ id: 1 }] } });
      return json({ status: 200, data: {} });
    });
    await v10(fetchMock).runServiceAction('svc-7', 'power_on');
    const paths = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(paths).toContain('/console/v1/idcsmart_common/host/svc-7/provision/on');
    // 通用产品没有 VNC 动作
    await expect(v10(fetchMock).runServiceAction('svc-7', 'vnc')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('mf_dcim 拒绝 hard_off（该家族无此动作）', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-8') return json({ status: 400, data: {} });
      if (path === '/console/v1/remf_cloud/svc-8') return json({ status: 400, data: {} });
      if (path === '/console/v1/mf_dcim/svc-8') return json({ status: 200, data: { id: 8 } });
      return json({ status: 200, data: {} });
    });
    const client = v10(fetchMock);
    await expect(client.runServiceAction('svc-8', 'hard_off')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('ZJMF V10 终止实例', () => {
  it('terminate 显式 501（无客户自助路由，不得假装成功）', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-10') return json({ status: 200, data: { id: 10 } });
      return json({ status: 200, data: {} });
    });
    const zjmf = new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    const error = await zjmf.runServiceAction('svc-10', 'terminate').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZJMFClientError);
    expect((error as ZJMFClientError).status).toBe(501);
    expect((error as ZJMFClientError).code).toBe('zjmf.client.unsupported');
    // 未向任何「终止」端点发请求
    const paths = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(paths.some((path) => path.includes('terminate'))).toBe(false);
  });
});

describe('buildForm 编码（PHP http_build_query 等价）', () => {
  it('对象数组按 chart[0][type]=cpu 展开（通用产品图表）', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === '/api/v1/auth') return json({ status: 200, data: { jwt: 'jwt' } });
      if (path === '/console/v1/mf_cloud/svc-11') return json({ status: 200, data: {} });
      if (path === '/console/v1/remf_cloud/svc-11') return json({ status: 200, data: {} });
      if (path === '/console/v1/mf_dcim/svc-11') return json({ status: 200, data: {} });
      if (path === '/console/v1/idcsmart_common/host/svc-11/configoption')
        return json({ status: 200, data: { configoption: [{ id: 1 }] } });
      return json({
        status: 200,
        data: { list: [{ time: 1700000000, value: 12.5 }] },
      });
    });
    const rows = await new ZJMFClient(
      {
        id: 'v10',
        baseUrl: 'https://v10.example',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    ).getServiceMetrics('svc-11');
    const chartCalls = fetchMock.mock.calls.filter(
      (call) =>
        new URL(call[0].toString()).pathname ===
        '/console/v1/idcsmart_common/host/svc-11/configoption/chart',
    );
    expect(chartCalls).toHaveLength(3);
    const bodies = chartCalls.map((call) => new URLSearchParams(call[1]?.body?.toString() ?? ''));
    const types = bodies.map((body) => body.get('chart[0][type]'));
    expect(new Set(types)).toEqual(new Set(['cpu', 'memory', 'bw']));
    for (const body of bodies) {
      expect(Number(body.get('chart[0][start]'))).toBeGreaterThan(0);
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('财务版监控（/provision/chart 取证）', () => {
  it('按 type 取数并解析成多条曲线，时间按 +08:00 解释', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/provision/chart/42') {
        const type = url.searchParams.get('type');
        if (type === 'cpu') {
          return json({
            status: 200,
            data: {
              unit: '%',
              label: ['CPU使用率(%)'],
              list: [[{ time: '2026-10-29 13:40:00', value: 0.05 }]],
            },
          });
        }
        if (type === 'memory') {
          return json({
            status: 200,
            data: {
              unit: 'B',
              label: ['总量(B)', '已用(B)'],
              list: [
                [{ time: '2026-10-29 13:40:00', value: 8589934592 }],
                [{ time: '2026-10-29 13:40:00', value: 1073741824 }],
              ],
            },
          });
        }
        if (type === 'network') return json({ status: 400, msg: '类型错误' });
        return json({
          status: 200,
          data: { unit: 'x', label: ['v'], list: [[{ time: '2026-10-29 13:40:00', value: 1 }]] },
        });
      }
      return json({ status: 200, data: {} });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    const metrics = await client.getServiceMetrics('42');
    const cpu = metrics.find((metric) => metric.id === 'cpu-0');
    expect(cpu?.label).toBe('CPU使用率(%)');
    expect(cpu?.unit).toBe('%');
    expect(cpu?.points).toEqual([{ t: Date.parse('2026-10-29T13:40:00+08:00'), v: 0.05 }]);
    expect(metrics.filter((metric) => metric.id.startsWith('memory-'))).toHaveLength(2);
    const requested = fetchMock.mock.calls
      .map((call) => new URL(call[0].toString()))
      .filter((url) => url.pathname === '/provision/chart/42')
      .map((url) => url.searchParams.get('type'));
    // 四个真实类型都试过；`network` 上游回 400，不再请求。
    expect([...requested].sort()).toEqual(['cpu', 'disk', 'flow', 'memory']);
  });
});

describe('可变更配置项白名单（upgrade/index 取证）', () => {
  it('把 data.host[] 解析成 key/label/当前档位/可选档位', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/upgrade/index/42') {
        return json({
          status: 200,
          data: {
            currency: { code: 'CNY' },
            host: [
              {
                oid: 3395984,
                id: 3395984,
                flag: 1,
                option_name: '快照数量',
                option_type: 1,
                qty: 0,
                subid: 15711334,
                suboption_name: '1个',
                sub: [
                  { id: 15711333, option_name: '0个', fee: null },
                  { id: 15711334, option_name: '1个', fee: 0 },
                  { id: 15711335, option_name: '2个', fee: 12.5 },
                ],
              },
              {
                oid: 3395985,
                id: 3395985,
                flag: 1,
                option_name: 'IP数量',
                subid: 15711336,
                suboption_name: '2个IP',
                sub: [{ id: 15711336, option_name: '2个IP' }],
              },
            ],
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    const options = await client.listChangeOptions('42');
    expect(options).toHaveLength(2);
    const snapshot = options![0]!;
    expect(snapshot.key).toBe('3395984');
    expect(snapshot.label).toBe('快照数量');
    expect(snapshot.current).toBe('15711334');
    expect(snapshot.currentLabel).toBe('1个');
    expect(snapshot.choices.map((choice) => choice.value)).toEqual([
      '15711333',
      '15711334',
      '15711335',
    ]);
    // 只有真正产生费用的档位才带 fee，null / 0 不制造「加价 0 元」的噪音。
    expect(snapshot.choices.map((choice) => choice.fee)).toEqual([undefined, undefined, 12.5]);
    expect(options![1]!.label).toBe('IP数量');
  });

  it('V10 协议没有这份白名单，返回 undefined 让 store 回退', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ status: 200, data: {} }));
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    expect(await client.listChangeOptions('42')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('财务版变配报价（upgrade_config_page 真实字段）', () => {
  it('从 total/subtotal 取权威差价，而不是不存在的 price_difference', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/upgrade/upgrade_config_post') {
        return json({ status: 200, msg: '请求成功' });
      }
      if (url.pathname === '/upgrade/upgrade_config_page') {
        return json({
          status: 200,
          msg: '请求成功',
          data: {
            currency: { code: 'CNY' },
            billingcycle: 'monthly',
            discount: '0.52',
            subtotal: '10.36',
            total: '9.84',
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    const quote = await client.calculateChangePrice('42', {
      selections: { '3395985': '15711338' },
    });
    expect(quote?.price).toBe(984);
    expect(quote?.breakdown?.map((row) => `${row.label}=${row.value}`)).toEqual([
      '小计=¥10.36',
      '上游优惠=¥0.52',
      '应付=¥9.84',
    ]);
    // 上游要求「只发变化项」：全量会被 400 打回。
    const post = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/upgrade/upgrade_config_post',
    );
    const body = new URLSearchParams(String(post?.[1]?.body)).toString();
    expect(body).toContain('hid=42');
    expect(body).toContain('configoption%5B3395985%5D=15711338');
  });
});

describe('降配（负差价）是合法报价', () => {
  it('上游 total 为负时不报「价格超出范围」，按 0 元变更', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/upgrade/upgrade_config_post') return json({ status: 200 });
      if (url.pathname === '/upgrade/upgrade_config_page') {
        return json({
          status: 200,
          data: { billingcycle: 'monthly', subtotal: '-29.00', total: '-29.00' },
        });
      }
      return json({ status: 200, data: {} });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    const quote = await client.calculateChangePrice('42', {
      selections: { '3395984': '15711333' },
    });
    expect(quote?.price).toBe(0);
  });
});

describe('救援模式状态（remoteInfo）', () => {
  const clientFor = (rescue: unknown) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/provision/custom/42') {
        return json({ status: 200, msg: '获取成功', data: { rescue } });
      }
      return json({ status: 200, data: {} });
    });
    return new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
  };

  it('rescue=1 视为已进入救援', async () => {
    expect(await clientFor(1).getRemoteInfo('42')).toEqual({ rescue: true });
  });

  it('rescue=0 视为正常系统', async () => {
    expect(await clientFor(0).getRemoteInfo('42')).toEqual({ rescue: false });
  });

  it('V10 没有 remoteInfo 契约，返回 null 不猜', async () => {
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'v10',
        username: 'u',
        password: 'p',
      },
      vi.fn<typeof fetch>(async () => json({ status: 200, data: {} })),
    );
    expect(await client.getRemoteInfo('42')).toBeNull();
  });
});

describe('到期终止：财务版提交停用申请', () => {
  const setup = (respond: (url: URL) => unknown) => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/host/cancel') {
        const body = new URLSearchParams(String(init?.body));
        return json(respond(url) ?? { status: 200, msg: '申请成功' });
      }
      return json({ status: 200, data: {} });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    return { client, fetchMock };
  };

  it('用 host_id + reason 调 host/cancel（传 id 会被上游判「取消类型错误」）', async () => {
    const { client, fetchMock } = setup(() => ({ status: 200, msg: '申请成功' }));
    await client.requestServiceCancel('42', '到期未续费');
    const post = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === '/host/cancel',
    );
    const body = new URLSearchParams(String(post?.[1]?.body));
    expect(body.get('host_id')).toBe('42');
    expect(body.get('reason')).toBe('到期未续费');
    expect(body.get('id')).toBeNull();
  });

  it('重复申请（上游回 406 已提交）按成功处理，不卡住到期清扫', async () => {
    const { client } = setup(() => ({ status: 406, msg: '该产品已提交过停用申请' }));
    await expect(client.requestServiceCancel('42', '到期未续费')).resolves.toBeUndefined();
  });

  it('真正的失败（未找到产品）必须上抛，让 sweep 继续重试', async () => {
    const { client } = setup(() => ({ status: 406, msg: '未找到该产品' }));
    await expect(client.requestServiceCancel('42', '到期未续费')).rejects.toThrow(/未找到该产品/);
  });
});

describe('换商品：不可换时前置失败，不把订单搅进去', () => {
  const build = (page: unknown) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (url.pathname === '/upgrade/upgrade_product_page') return json(page);
      return json({ status: 200, msg: 'ok' });
    });
    const client = new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
    return { client, fetchMock };
  };

  it('换购页拒绝时抛 501 且不发 upgrade_product_post', async () => {
    const { client, fetchMock } = build({
      status: 400,
      msg: '当前产品无法升级或降级可配置项',
    });
    await expect(client.changeProduct('42', '99')).rejects.toThrow(/无法升级或降级可配置项/);
    const posted = fetchMock.mock.calls.filter(
      (call) => new URL(call[0].toString()).pathname === '/upgrade/upgrade_product_post',
    );
    expect(posted).toHaveLength(0);
  });

  it('换购页可用时继续提交换购并结算', async () => {
    const { client, fetchMock } = build({ status: 200, data: { product: [] } });
    await client.changeProduct('42', '99');
    const posted = fetchMock.mock.calls.map((call) => new URL(call[0].toString()).pathname);
    expect(posted).toContain('/upgrade/upgrade_product_post');
    expect(posted).toContain('/upgrade/checkout_upgrade_product');
  });
});

describe('已用流量（单位 GB 由速率曲线交叉取证）', () => {
  const build = (rows: unknown, url?: { start?: string; end?: string }) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const u = new URL(input.toString());
      if (u.pathname === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
      if (u.pathname === '/host/trafficusage') {
        if (url) url.start = u.searchParams.get('start') ?? undefined;
        if (url) url.end = u.searchParams.get('end') ?? undefined;
        return json({ status: 200, data: rows });
      }
      return json({ status: 200, data: {} });
    });
    return new ZJMFClient(
      {
        id: 'up',
        baseUrl: 'https://billing.example/',
        protocol: 'finance',
        username: 'u',
        password: 'p',
      },
      fetchMock,
    );
  };

  it('累加周期内 in/out，返回 GB 合计', async () => {
    const client = build([
      { time: '2026-10-29 13:00:00', in: 0.63, out: 0.02 },
      { time: '2026-10-29 14:00:00', in: 1.37, out: '0.98' },
    ]);
    const usage = await client.getTrafficUsage('42');
    expect(usage?.inGb).toBeCloseTo(2.0, 5);
    expect(usage?.outGb).toBeCloseTo(1.0, 5);
    expect(usage?.totalGb).toBeCloseTo(3.0, 5);
    expect(usage?.points).toBe(2);
  });

  it('默认不带窗口（上游按当前计费周期返回），显式传入才带 start/end', async () => {
    const seen: { start?: string; end?: string } = {};
    await build([{ in: 1, out: 0 }], seen).getTrafficUsage('42');
    expect(seen).toEqual({ start: undefined, end: undefined });
    const seen2: { start?: string; end?: string } = {};
    await build([{ in: 1, out: 0 }], seen2).getTrafficUsage('42', {
      start: '2026-09-01',
      end: '2026-10-30',
    });
    expect(seen2).toEqual({ start: '2026-09-01', end: '2026-10-30' });
  });

  it('上游无数据时返回 null（不假装用了 0）', async () => {
    expect(await build([]).getTrafficUsage('42')).toBeNull();
  });
});
