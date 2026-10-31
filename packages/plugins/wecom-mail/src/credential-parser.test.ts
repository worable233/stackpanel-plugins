import { describe, expect, it } from 'vitest';
import { originFromHeaders, parseCredentials } from './credential-parser.js';

/**
 * 「一次粘贴」的可靠性全在这个纯函数里。
 *
 * 管理员不会按我们希望的格式粘贴：后台复制出来的是带中文标签的两行、一段
 * JSON、一条带 query 的链接，或者干脆只有一串 `ww…`。这些形态都真会出现，
 * 所以每一种都钉一条用例；认不出来时必须**说清缺哪一个**，而不是笼统报错。
 */

const CORP_ID = 'ww0123456789abcdef';
const SECRET = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

describe('parseCredentials', () => {
  it('reads a plain two-line paste', () => {
    expect(parseCredentials(`${CORP_ID}\n${SECRET}`)).toEqual({
      corpId: CORP_ID,
      corpSecret: SECRET,
      gaps: [],
    });
  });

  it('reads labelled pairs with Chinese labels and full-width colons', () => {
    const text = `企业ID：${CORP_ID}\n应用Secret：${SECRET}`;
    expect(parseCredentials(text)).toMatchObject({ corpId: CORP_ID, corpSecret: SECRET });
  });

  it('reads an equals-separated pair (URL query or shell env style)', () => {
    expect(parseCredentials(`corpid=${CORP_ID}&corpsecret=${SECRET}`)).toMatchObject({
      corpId: CORP_ID,
      corpSecret: SECRET,
    });
  });

  it('reads JSON with vendor-style keys', () => {
    const text = JSON.stringify({ corpid: CORP_ID, corpsecret: SECRET });
    expect(parseCredentials(text)).toMatchObject({ corpId: CORP_ID, corpSecret: SECRET });
  });

  it('reads nested JSON and snake_case aliases', () => {
    const text = JSON.stringify({
      app: { corp_id: CORP_ID, credentials: { secret: SECRET } },
    });
    expect(parseCredentials(text)).toMatchObject({ corpId: CORP_ID, corpSecret: SECRET });
  });

  it('tolerates junk around the credentials (comments, blank lines, quotes)', () => {
    const text = `# 企业微信自建应用\n\n企业ID: "${CORP_ID}"\n密钥: '${SECRET}'\n（来自后台）`;
    expect(parseCredentials(text)).toMatchObject({ corpId: CORP_ID, corpSecret: SECRET });
  });

  it('accepts a link that carries both values', () => {
    const text = `https://work.weixin.qq.com/wework_admin/frame?corpid=${CORP_ID}&corpsecret=${SECRET}#apps`;
    expect(parseCredentials(text)).toMatchObject({ corpId: CORP_ID, corpSecret: SECRET });
  });

  it('never mistakes the corp id for the secret', () => {
    const result = parseCredentials(CORP_ID);
    expect(result.corpId).toBe(CORP_ID);
    expect(result.corpSecret).toBeUndefined();
    expect(result.gaps).toEqual(['wecom-mail.missing_secret']);
  });

  it('reports a missing corp id when only the secret was pasted', () => {
    const result = parseCredentials(SECRET);
    expect(result.corpId).toBeUndefined();
    expect(result.corpSecret).toBe(SECRET);
    expect(result.gaps).toEqual(['wecom-mail.missing_corp_id']);
  });

  it('reports both gaps for empty or unrelated text', () => {
    for (const text of ['', '   ', undefined, null, '你好，这是截图']) {
      expect(parseCredentials(text).gaps).toEqual([
        'wecom-mail.missing_corp_id',
        'wecom-mail.missing_secret',
      ]);
    }
  });
});

describe('originFromHeaders', () => {
  it('prefers the forwarded host and honours an https forwarded proto', () => {
    expect(
      originFromHeaders({
        host: 'internal:8080',
        'x-forwarded-host': 'panel.example.com',
        'x-forwarded-proto': 'https',
      }),
    ).toBe('https://panel.example.com');
  });

  it('rejects an unknown or missing scheme instead of guessing', () => {
    expect(originFromHeaders({ host: 'panel.example.com' })).toBeNull();
    expect(originFromHeaders({ host: 'panel.example.com', 'x-forwarded-proto': 'ftp' })).toBeNull();
  });

  it('refuses a host that smuggles a path or credentials', () => {
    expect(originFromHeaders({ 'x-forwarded-proto': 'https', host: 'evil.com/@x.com' })).toBeNull();
    expect(
      originFromHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'https://evil.com' }),
    ).toBeNull();
  });

  it('takes the first entry of a comma-separated forwarded header', () => {
    expect(
      originFromHeaders({ host: 'panel.example.com', 'x-forwarded-proto': 'https, http' }),
    ).toBe('https://panel.example.com');
  });
});
