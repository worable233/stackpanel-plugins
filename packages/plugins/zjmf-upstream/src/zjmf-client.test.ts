import { describe, expect, it, vi } from "vitest";
import {
  applyMarkup,
  decimalToMinor,
  isUnsafeIpAddress,
  normalizeBaseUrl,
  ZJMFClient,
  ZJMFClientError,
} from "./zjmf-client.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ZJMFClient", () => {
  it("uses the legacy V1 JWT field and product routes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login")
        return json({ status: 200, jwt: "legacy-jwt" });
      if (path === "/api/product/list") {
        return json({
          status: 200,
          data: {
            currency_code: "CNY",
            list: [{ id: 7, name: "VPS", price: "9.90" }],
          },
        });
      }
      return json({
        status: 200,
        data: {
          product: { id: 7, name: "VPS", description: "1C1G", price: "9.90" },
        },
      });
    });
    const client = new ZJMFClient(
      {
        id: "legacy",
        baseUrl: "https://finance.example",
        protocol: "finance",
        username: "u",
        password: "p",
      },
      fetchMock,
    );

    const listed = await client.listProducts();
    const detail = await client.getProduct("7");

    expect(listed.currency).toBe("CNY");
    expect(listed.products).toMatchObject([
      { id: "7", name: "VPS", price: "9.90" },
    ]);
    expect(detail.description).toBe("1C1G");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer legacy-jwt",
    });
  });

  it("uses the V10 nested JWT field and retries an expired token once", async () => {
    let loginCount = 0;
    let productCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth") {
        loginCount += 1;
        return json({ status: 200, data: { jwt: `v10-${loginCount}` } });
      }
      productCount += 1;
      return productCount === 1
        ? json({ status: 401, msg: "expired" })
        : json({
            status: 200,
            data: { list: [{ id: "a", name: "Cloud", sale_price: "12.34" }] },
          });
    });
    const client = new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example/",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    );

    const listed = await client.listProducts();

    expect(listed.products[0]).toMatchObject({ id: "a", price: "12.34" });
    expect(loginCount).toBe(2);
    expect(productCount).toBe(2);
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer v10-2",
    });
  });
});

describe("ZJMF failure vs empty distinction (handoff #2)", () => {
  function clientFor(
    fetchMock: typeof fetch,
    protocol: "finance" | "v10" = "finance",
    allowUnverifiedV10Routes = false,
  ): ZJMFClient {
    return new ZJMFClient(
      {
        id: "up",
        baseUrl: "https://billing.example/",
        protocol,
        username: "u",
        password: "p",
        allowUnverifiedV10Routes,
      },
      fetchMock,
    );
  }

  it("V1: listServiceResources throws on HTTP 500 instead of returning []", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return new Response("boom", { status: 500 });
    });
    await expect(
      clientFor(fetchMock).listServiceResources("42", "snapshot"),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it("V2: listServiceResources throws when auth keeps returning 401", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return json({ status: 401, msg: "unauthorized" });
    });
    await expect(
      clientFor(fetchMock).listServiceResources("42", "snapshot"),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it("V3: listServiceResources returns [] only on a successful empty set", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return json({ status: 200, data: { list: [] } });
    });
    await expect(
      clientFor(fetchMock).listServiceResources("42", "snapshot"),
    ).resolves.toEqual([]);
  });

  it("V4: getServiceMetrics throws on HTTP 500 (finance)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return new Response("boom", { status: 500 });
    });
    await expect(
      clientFor(fetchMock).getServiceMetrics("42"),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it("V5: calculateChangePrice throws on HTTP 500 instead of null", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return new Response("boom", { status: 500 });
    });
    await expect(
      clientFor(fetchMock).calculateChangePrice("42", {
        selections: { "1": 2 },
      }),
    ).rejects.toBeInstanceOf(ZJMFClientError);
  });

  it("V6: changeOwner 在上游无自助转移端点时返回 null 且不发请求", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      return new Response("boom", { status: 500 });
    });
    await expect(
      clientFor(fetchMock, "v10", true).changeOwner("svc-1", "u-2"),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("V7: V10 子资源走 console/v1 真实路由（快照列表）", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-1")
        return json({ status: 200, data: { id: 1 } });
      if (path === "/console/v1/mf_cloud/svc-1/snapshot")
        return json({
          status: 200,
          data: { list: [{ id: 7, name: "snap-a", status: 1 }] },
        });
      return new Response("boom", { status: 500 });
    });
    const rows = await clientFor(fetchMock, "v10").listServiceResources(
      "svc-1",
      "snapshot",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("7");
    const paths = fetchMock.mock.calls.map(
      (call) => new URL(call[0].toString()).pathname,
    );
    expect(paths).toContain("/console/v1/mf_cloud/svc-1/snapshot");
    // 旧的虚构路径不得再出现。
    expect(paths.some((path) => path.startsWith("/api/v1/service"))).toBe(
      false,
    );
  });

  it("V7b: 真正未取证的能力（换商品）仍报 unsupported", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ status: 200, data: {} }),
    );
    const error = await clientFor(fetchMock, "v10")
      .changeProduct("svc-1", "prod-2")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZJMFClientError);
    expect((error as ZJMFClientError).code).toBe("zjmf.client.unsupported");
  });

  it("V7c: 未开启实验开关时换商品不发任何请求", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ status: 200, data: {} }),
    );
    await expect(
      clientFor(fetchMock, "v10").changeProduct("svc-1", "prod-2"),
    ).rejects.toBeInstanceOf(ZJMFClientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("V8: finance branch is unaffected by the V10 unsupported guard", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/host/monitor")
        return json({ status: 200, data: { cpu_usage: [{ t: 1, v: 2 }] } });
      return json({ status: 200, data: {} });
    });
    const metrics = await clientFor(fetchMock, "finance").getServiceMetrics(
      "42",
    );
    expect(metrics[0]).toMatchObject({ id: "cpu_usage" });
  });

  it("V7b: experimental switch restores the unverified V10 route", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      return json({ status: 200, data: { list: [{ id: 1, name: "snap" }] } });
    });
    const rows = await clientFor(fetchMock, "v10", true).listServiceResources(
      "svc-1",
      "snapshot",
    );
    expect(rows).toEqual([{ id: "1", fields: { name: "snap" } }]);
  });
});

describe("ZJMF value normalization", () => {
  it("converts prices exactly and applies markup in integer minor units", () => {
    expect(decimalToMinor("12.3")).toBe(1230);
    expect(applyMarkup(1230, 250)).toBe(1261);
    expect(() => decimalToMinor("12.345")).toThrow(ZJMFClientError);
  });

  it("normalizes an upstream base URL and rejects embedded credentials", () => {
    expect(normalizeBaseUrl("https://billing.example/base/")).toBe(
      "https://billing.example/base/",
    );
    expect(() => normalizeBaseUrl("https://user:pass@billing.example")).toThrow(
      ZJMFClientError,
    );
    expect(() => normalizeBaseUrl("https://[::1]")).toThrow(ZJMFClientError);
    expect(isUnsafeIpAddress("10.0.0.1")).toBe(true);
    expect(isUnsafeIpAddress("fd00::1")).toBe(true);
    expect(isUnsafeIpAddress("1.1.1.1")).toBe(false);
  });

  it("flags IPv4-mapped IPv6 bypasses and reserved ranges (audit M-1)", () => {
    expect(isUnsafeIpAddress("::ffff:7f00:1")).toBe(true);
    expect(isUnsafeIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isUnsafeIpAddress("::ffff:a9fe:a9fe")).toBe(true);
    expect(isUnsafeIpAddress("100.64.0.1")).toBe(true);
    expect(isUnsafeIpAddress("198.18.0.1")).toBe(true);
    expect(isUnsafeIpAddress("224.0.0.1")).toBe(true);
    expect(isUnsafeIpAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("ZJMF service provisioning", () => {
  function clientFor(
    fetchMock: typeof fetch,
    protocol: "finance" | "v10" = "finance",
    allowUnverifiedV10Routes = false,
  ): ZJMFClient {
    return new ZJMFClient(
      {
        id: "up",
        baseUrl: "https://billing.example/",
        protocol,
        username: "u",
        password: "p",
        allowUnverifiedV10Routes,
      },
      fetchMock,
    );
  }

  it("creates a finance service via the cart chain and extracts the host id", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      calls.push(path);
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/cart/clear") return json({ status: 200, data: {} });
      if (path === "/cart/add_to_shop") return json({ status: 200, data: {} });
      if (path === "/cart/settle") {
        return json({ status: 200, data: { hostid: 42, invoiceid: 7001 } });
      }
      if (path === "/apply_credit") return json({ status: 1001, data: {} });
      return json({ status: 200, data: {} });
    });
    const client = clientFor(fetchMock);
    const result = await client.createService("prod-1", {
      cycle: "monthly",
      selections: { "3201217": 15038165 },
    });

    expect(calls).toEqual([
      "/zjmf_api_login",
      "/cart/clear",
      "/cart/add_to_shop",
      "/cart/settle",
      "/apply_credit",
    ]);
    expect(result.providerServiceId).toBe("42");
    expect(result.runtime).toMatchObject({
      paid: true,
      invoiceId: "7001",
      billingCycle: "monthly",
    });
    const addCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === "/cart/add_to_shop",
    );
    expect(addCall?.[1]?.body?.toString()).toContain(
      "configoption%5B3201217%5D=15038165",
    );
    expect(addCall?.[1]?.body?.toString()).toContain("billingcycle=monthly");
  });

  // 证据：`app/common/logic/ResModuleLogic.php:382-435` 上游代理自己的下单链路。
  it("creates a V10 service through the console cart flow", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "v10" } });
      if (path === "/console/v1/cart") return json({ status: 200, data: {} });
      if (path === "/console/v1/cart/settle")
        return json({
          status: 200,
          data: { host_ids: [101], order_id: "8001", amount: "0.00" },
        });
      if (path === "/console/v1/mf_cloud/101")
        return json({
          status: 200,
          data: { id: 101, ip: "203.0.113.10", username: "root", password: " pw " },
        });
      return json({ status: 200, data: {} });
    });
    const result = await clientFor(fetchMock, "v10", true).createService(
      "prod-1",
      { cycle: "monthly", selections: { "3201217": 15038165 } },
    );
    expect(result.providerServiceId).toBe("101");
    expect(result.credentials).toMatchObject({ username: "root" });
    const paths = fetchMock.mock.calls.map((call) =>
      new URL(call[0].toString()).pathname,
    );
    expect(paths).toContain("/console/v1/cart");
    expect(paths).toContain("/console/v1/cart/settle");
    const cartCall = fetchMock.mock.calls.find(
      (call) =>
        new URL(call[0].toString()).pathname === "/console/v1/cart" &&
        call[1]?.method === "POST",
    );
    const body = cartCall?.[1]?.body?.toString() ?? "";
    expect(body).toContain("product_id=prod-1");
    // PHP 风格嵌套编码
    expect(body).toContain("config_options%5Bconfigoption%5D%5B3201217%5D=15038165");
    expect(body).toContain("config_options%5Bcycle%5D=monthly");
  });

  it("fetches finance service detail via host header with ip and status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/host/header") {
        return json({
          status: 200,
          data: {
            host_data: {
              id: 42,
              ip: "203.0.113.10",
              username: "root",
              status: "Active",
            },
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const detail = await clientFor(fetchMock).getService("42");
    expect(detail).toMatchObject({
      ip: "203.0.113.10",
      username: "root",
      status: "Active",
    });
  });

  it("maps finance dedicatedip/domainstatus and enriches specs from host list", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/host/header") {
        return json({
          status: 200,
          data: {
            host_data: {
              id: 30463,
              dedicatedip: "86.53.111.148",
              username: "root",
              password: "secret",
              status: "Paid",
              domainstatus: "Active",
              domainstatus_desc: "已激活",
              os: "Debian-13",
            },
          },
        });
      }
      if (path === "/host/list") {
        return json({
          status: 200,
          data: {
            list: [
              {
                id: 30463,
                cpu: "1核",
                memory: "1G",
                system_disk_size: "15G",
                bw: "100Mbps",
                area: "DE^德国 法兰克福",
              },
            ],
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const detail = await clientFor(fetchMock).getService("30463");
    // 真实运行状态以 domainstatus 为准，status（Paid）是账单状态。
    expect(detail).toMatchObject({
      ip: "86.53.111.148",
      username: "root",
      password: "secret",
      status: "Active",
      statusLabel: "已激活",
      specs: {
        cpu: "1核",
        memory: "1G",
        disk: "15G",
        bandwidth: "100Mbps",
        region: "德国 法兰克福",
        os: "Debian-13",
      },
    });
  });

  it("normalizes finance monitor payloads into metric series", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/host/monitor") {
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
    const metrics = await clientFor(fetchMock).getServiceMetrics("42");
    const cpu = metrics.find((m) => m.id === "cpu_usage");
    expect(cpu?.points).toHaveLength(2);
    expect(cpu?.points[0]).toMatchObject({ t: 1700000000000, v: 12.5 });
  });

  it("posts a finance action to the provision endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/provision/default") return json({ status: 200, data: {} });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).runServiceAction("42", "reboot");
    const actionCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === "/provision/default",
    );
    expect(actionCall?.[1]?.body?.toString()).toContain("func=reboot");
    expect(actionCall?.[1]?.body?.toString()).toContain("is_api=1");
  });

  it("forwards action params and returns the upstream payload (finance)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/provision/default") {
        return json({ status: 200, data: { password: "S3cretPass!" } });
      }
      return json({ status: 200, data: {} });
    });
    const result = await clientFor(fetchMock).runServiceAction(
      "42",
      "reset_password",
      {
        password: "S3cretPass!",
      },
    );
    const actionCall = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === "/provision/default",
    );
    const body = actionCall?.[1]?.body?.toString() ?? "";
    expect(body).toContain("func=reset_password");
    expect(body).toContain("password=S3cretPass%21");
    expect(result).toMatchObject({ data: { password: "S3cretPass!" } });
  });

  // 证据：`mf_cloud/route.php:94-102` 每个动作一个端点。
  it("routes V10 actions to the real console endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-9")
        return json({ status: 200, data: { id: 9 } });
      return json({
        status: 200,
        data: { url: "https://console.example/vnc", vnc_pass: "p" },
      });
    });
    const client = new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    );
    const result = await client.runServiceAction("svc-9", "reinstall", {
      os: "ubuntu-22.04",
    });
    const actionCall = fetchMock.mock.calls.find(
      (call) =>
        new URL(call[0].toString()).pathname ===
        "/console/v1/mf_cloud/svc-9/reinstall",
    );
    expect(actionCall).toBeDefined();
    const body = actionCall?.[1]?.body?.toString() ?? "";
    expect(body).toContain("os=ubuntu-22.04");
    expect(result).toMatchObject({
      data: { url: "https://console.example/vnc" },
    });
    // 旧虚构路径不得再出现。
    const paths = fetchMock.mock.calls.map((call) =>
      new URL(call[0].toString()).pathname,
    );
    expect(paths.some((path) => path.includes("/api/v1/service"))).toBe(false);
  });

  it("VNC 动作带上 more=1 并落在控制台路由上", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-9")
        return json({ status: 200, data: { id: 9 } });
      return json({
        status: 200,
        data: { vnc_url: "https://vnc.example/x", vnc_pass: "p" },
      });
    });
    const client = new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    );
    await client.runServiceAction("svc-9", "vnc");
    const call = fetchMock.mock.calls.find(
      (entry) =>
        new URL(entry[0].toString()).pathname === "/console/v1/mf_cloud/svc-9/vnc",
    );
    expect(call).toBeDefined();
    expect(new URL(call![0].toString()).search).toBe("?more=1");
  });

  it("does not let caller params override reserved action fields (finance)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).runServiceAction("42", "power_off", {
      func: "terminate",
      id: "999",
      is_api: "0",
    });
    const body =
      fetchMock.mock.calls
        .find(
          (call) =>
            new URL(call[0].toString()).pathname === "/provision/default",
        )?.[1]
        ?.body?.toString() ?? "";
    // 保留字段以客户端为准：func=off、id=42、is_api=1，参数不得覆盖。
    expect(body).toContain("func=off");
    expect(body).toContain("id=42");
    expect(body).toContain("is_api=1");
    expect(body).not.toContain("func=terminate");
  });

  it("renews a finance service via host/renew and pays the invoice", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/host/renew")
        return json({ status: 200, data: { invoiceid: 8801 } });
      if (path === "/apply_credit") return json({ status: 1001, data: {} });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).renewService("42", { cycle: "monthly" });
    const renew = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === "/host/renew",
    );
    expect(renew?.[1]?.body?.toString()).toContain("hostid=42");
    expect(renew?.[1]?.body?.toString()).toContain("billingcycles=monthly");
    const credit = fetchMock.mock.calls.find(
      (call) => new URL(call[0].toString()).pathname === "/apply_credit",
    );
    expect(credit?.[1]?.body?.toString()).toContain("invoiceid=8801");
  });

  it("changes a finance package via upgrade config chain", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/upgrade/checkout_config_upgrade") {
        return json({ status: 200, data: { invoiceid: 9001 } });
      }
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).changePackage("42", {
      selections: { "3201": 777 },
    });
    const post = fetchMock.mock.calls.find(
      (call) =>
        new URL(call[0].toString()).pathname === "/upgrade/upgrade_config_post",
    );
    const body = post?.[1]?.body?.toString() ?? "";
    expect(body).toContain("hid=42");
    expect(body).toContain("configoption%5B3201%5D=777");
  });

  it("quotes a finance change price from the upgrade config page", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/upgrade/upgrade_config_page") {
        return json({
          status: 200,
          data: {
            price_difference: "12.30",
            preview: [{ name: "CPU", value: "2核=>4核", price: "10.00" }],
          },
        });
      }
      return json({ status: 200, data: {} });
    });
    const quote = await clientFor(fetchMock).calculateChangePrice("42", {
      selections: { "3201": 777 },
    });
    expect(quote?.price).toBe(1230);
    expect(quote?.breakdown?.[0]).toMatchObject({
      label: "CPU",
      value: "2核=>4核",
      price: 1000,
    });
  });

  it("lists and creates finance service resources via provision/custom", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/provision/custom/content") {
        return json({
          status: 200,
          data: { list: [{ id: 9, name: "snap-1" }] },
        });
      }
      return json({ status: 200, data: {} });
    });
    const rows = await clientFor(fetchMock).listServiceResources(
      "42",
      "snapshot",
    );
    expect(rows).toEqual([{ id: "9", fields: { name: "snap-1" } }]);

    await clientFor(fetchMock).createServiceResource("42", "snapshot", {
      disk_id: "5",
      name: "snap-2",
    });
    const create = fetchMock.mock.calls.find(
      (call) =>
        new URL(call[0].toString()).pathname === "/provision/custom/42" &&
        call[1]?.body?.toString().includes("func=createSnap"),
    );
    expect(create?.[1]?.body?.toString()).toContain("disk_id=5");
  });

  it("runs a finance resource action with the mapped func", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      return json({ status: 200, data: {} });
    });
    await clientFor(fetchMock).runResourceAction(
      "42",
      "snapshot",
      "9",
      "restore",
    );
    const call = fetchMock.mock.calls.find(
      (candidate) =>
        new URL(candidate[0].toString()).pathname === "/provision/custom/42",
    );
    const body = call?.[1]?.body?.toString() ?? "";
    expect(body).toContain("func=restoreSnap");
    expect(body).toContain("id=9");
  });
});

describe("ZJMF config matrix mapping", () => {
  function clientFor(fetchMock: typeof fetch): ZJMFClient {
    return new ZJMFClient(
      {
        id: "up",
        baseUrl: "https://billing.example/",
        protocol: "finance",
        username: "u",
        password: "p",
      },
      fetchMock,
    );
  }

  it("maps upstream options to grouped, price-per-cycle choices", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/zjmf_api_login") return json({ status: 200, jwt: "jwt" });
      if (path === "/cart/set_config") {
        return json({
          status: 200,
          product: {
            cycle: [
              {
                billingcycle: "monthly",
                billingcycle_zh: "月付",
                product_price: "60.00",
              },
              {
                billingcycle: "yearly",
                billingcycle_zh: "年付",
                product_price: "600.00",
              },
            ],
          },
          option: [
            {
              id: 320,
              option_name: "CPU",
              option_type: 1,
              sub: [
                {
                  id: 3201,
                  option_name: "2 核",
                  pricing: { monthly: 10, yearly: 100 },
                },
                {
                  id: 3202,
                  option_name: "4 核",
                  pricing: { monthly: 20, yearly: 200 },
                },
              ],
            },
            {
              id: 321,
              option_name: "Windows 镜像",
              option_type: 5,
              configoption_id: 320,
              configoption_sub_id: 3202,
              sub: { win: { child: [{ id: 5001, version: "Windows 2022" }] } },
            },
          ],
        });
      }
      return json({ status: 200, data: {} });
    });
    const config = await clientFor(fetchMock).getConfig("prod-1");
    expect(config?.cycles).toHaveLength(2);
    const cpu = config?.options.find((option) => option.id === "320");
    expect(cpu?.group).toBe("规格");
    expect(cpu?.choices[0]).toMatchObject({
      id: "3201",
      prices: { monthly: 1000, yearly: 10000 },
    });
    const image = config?.options.find((option) => option.id === "321");
    expect(image?.group).toBe("镜像");
    expect(image?.visibleWhen).toEqual({ field: "320", equals: "3202" });
  });
});

describe("ZJMF V10 console 契约补充", () => {
  const v10 = (fetchMock: typeof fetch) =>
    new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    );

  it("家族自动探测：mf_cloud 404 后回退到 remf_cloud", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-2")
        return json({ status: 404, msg: "模块不存在" });
      if (path === "/console/v1/remf_cloud/svc-2")
        return json({ status: 200, data: { id: 2, ip: "198.51.100.7" } });
      if (path === "/console/v1/host/svc-2")
        return json({ status: 200, data: { host: { status: "Active" } } });
      return json({ status: 400, msg: "module not found" });
    });
    const detail = await v10(fetchMock).getService("svc-2");
    expect(detail["ip"]).toBe("198.51.100.7");
    const paths = fetchMock.mock.calls.map((call) =>
      new URL(call[0].toString()).pathname,
    );
    expect(paths).toContain("/console/v1/remf_cloud/svc-2");
  });

  it("家族探测不会把 HTTP 200 + status=400 误判为命中", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-3")
        return json({ status: 400, msg: "实例不存在", data: {} });
      if (path === "/console/v1/remf_cloud/svc-3")
        return json({ status: 200, data: { id: 3, ip: "198.51.100.8" } });
      return json({ status: 200, data: {} });
    });
    const detail = await v10(fetchMock).getService("svc-3");
    expect(detail["ip"]).toBe("198.51.100.8");
  });

  it("续费 Unpaid 时按 credit → pay 走余额支付", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/host/svc-4/renew")
        return json({ status: 200, code: "Unpaid", data: { id: 5001 } });
      if (path === "/console/v1/credit")
        return json({ status: 200, data: { id: 5001 } });
      if (path === "/console/v1/pay")
        return json({ status: 200, data: { status: 200 } });
      return json({ status: 400, msg: "unexpected" });
    });
    const result = await v10(fetchMock).renewService("svc-4", {
      cycle: "monthly",
    });
    expect(result).toBeTruthy();
    const calls = fetchMock.mock.calls.map((call) => ({
      path: new URL(call[0].toString()).pathname,
      body: call[1]?.body?.toString() ?? "",
    }));
    expect(calls.some((call) => call.path === "/console/v1/credit")).toBe(true);
    const pay = calls.find((call) => call.path === "/console/v1/pay");
    expect(pay?.body).toContain("gateway=credit");
    expect(pay?.body).toContain("id=5001");
  });

  it("due_time（Unix 秒）转成 ISO 到期时间", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-5")
        return json({ status: 200, data: { id: 5, due_time: 1767225600 } });
      if (path === "/console/v1/host/svc-5")
        return json({
          status: 200,
          data: { host: { status: "Active", due_time: 1767225600 } },
        });
      return json({ status: 200, data: {} });
    });
    const detail = await v10(fetchMock).getService("svc-5");
    expect(detail["expiresAt"]).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("ZJMF V10 家族差异", () => {
  const v10 = (fetchMock: typeof fetch) =>
    new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    );

  it("idcsmart_common 走 provision/:func（无 vnc）", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-7")
        return json({ status: 200, data: {} });
      if (path === "/console/v1/remf_cloud/svc-7")
        return json({ status: 200, data: {} });
      if (path === "/console/v1/mf_dcim/svc-7")
        return json({ status: 200, data: {} });
      if (path === "/console/v1/idcsmart_common/host/svc-7/configoption")
        return json({ status: 200, data: { configoption: [{ id: 1 }] } });
      return json({ status: 200, data: {} });
    });
    await v10(fetchMock).runServiceAction("svc-7", "power_on");
    const paths = fetchMock.mock.calls.map((call) =>
      new URL(call[0].toString()).pathname,
    );
    expect(paths).toContain(
      "/console/v1/idcsmart_common/host/svc-7/provision/on",
    );
    // 通用产品没有 VNC 动作
    await expect(
      v10(fetchMock).runServiceAction("svc-7", "vnc"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("mf_dcim 拒绝 hard_off（该家族无此动作）", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-8")
        return json({ status: 400, data: {} });
      if (path === "/console/v1/remf_cloud/svc-8")
        return json({ status: 400, data: {} });
      if (path === "/console/v1/mf_dcim/svc-8")
        return json({ status: 200, data: { id: 8 } });
      return json({ status: 200, data: {} });
    });
    const client = v10(fetchMock);
    await expect(
      client.runServiceAction("svc-8", "hard_off"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("ZJMF V10 终止实例", () => {
  it("terminate 显式 501（无客户自助路由，不得假装成功）", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-10")
        return json({ status: 200, data: { id: 10 } });
      return json({ status: 200, data: {} });
    });
    const zjmf = new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    );
    const error = await zjmf
      .runServiceAction("svc-10", "terminate")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZJMFClientError);
    expect((error as ZJMFClientError).status).toBe(501);
    expect((error as ZJMFClientError).code).toBe("zjmf.client.unsupported");
    // 未向任何「终止」端点发请求
    const paths = fetchMock.mock.calls.map((call) =>
      new URL(call[0].toString()).pathname,
    );
    expect(paths.some((path) => path.includes("terminate"))).toBe(false);
  });
});

describe("buildForm 编码（PHP http_build_query 等价）", () => {
  it("对象数组按 chart[0][type]=cpu 展开（通用产品图表）", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/v1/auth")
        return json({ status: 200, data: { jwt: "jwt" } });
      if (path === "/console/v1/mf_cloud/svc-11")
        return json({ status: 200, data: {} });
      if (path === "/console/v1/remf_cloud/svc-11")
        return json({ status: 200, data: {} });
      if (path === "/console/v1/mf_dcim/svc-11")
        return json({ status: 200, data: {} });
      if (path === "/console/v1/idcsmart_common/host/svc-11/configoption")
        return json({ status: 200, data: { configoption: [{ id: 1 }] } });
      return json({
        status: 200,
        data: { list: [{ time: 1700000000, value: 12.5 }] },
      });
    });
    const rows = await new ZJMFClient(
      {
        id: "v10",
        baseUrl: "https://v10.example",
        protocol: "v10",
        username: "u",
        password: "p",
      },
      fetchMock,
    ).getServiceMetrics("svc-11");
    const chartCalls = fetchMock.mock.calls.filter(
      (call) =>
        new URL(call[0].toString()).pathname ===
        "/console/v1/idcsmart_common/host/svc-11/configoption/chart",
    );
    expect(chartCalls).toHaveLength(3);
    const bodies = chartCalls.map(
      (call) => new URLSearchParams(call[1]?.body?.toString() ?? ""),
    );
    const types = bodies.map((body) => body.get("chart[0][type]"));
    expect(new Set(types)).toEqual(new Set(["cpu", "memory", "bw"]));
    for (const body of bodies) {
      expect(Number(body.get("chart[0][start]"))).toBeGreaterThan(0);
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});
