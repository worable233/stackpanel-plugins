/**
 * 产物签名（C2）契约测试。
 *
 * 三条不变量，任何一条破了就是事故：
 * 1. 签名绑定 taskId + index + 过期时间（改任何一个都必须失效）；
 * 2. 过期即失效（不因为「链接是自己发的」而宽容）；
 * 3. 密钥不落日志、不进产物 URL（这里通过「签名里查不到密钥」间接保证）。
 */
import { describe, expect, it } from 'vitest';

import {
  artifactSecret,
  buildArtifactLinks,
  readArtifacts,
  signArtifact,
  verifyArtifact,
} from './artifacts.js';
import type { GatewayRuntime } from './runtime.js';
import { InMemoryState } from './state-stub.test-util.js';
import type { TaskRow } from './repository.js';

const SECRET = 'x'.repeat(64);

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task_1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: {
      userId: 'u1',
      kind: 'video',
      endpoint: 'openai-video',
      status: 'SUCCEEDED',
      attempts: 1,
    },
    ...over,
  } as unknown as TaskRow;
}

describe('signArtifact / verifyArtifact', () => {
  const expires = Date.now() + 60_000;

  it('正确签名可通过校验', () => {
    const sig = signArtifact(SECRET, 'task_1', 0, expires);
    expect(verifyArtifact(SECRET, 'task_1', 0, expires, sig, Date.now())).toBe(true);
  });

  it('改 taskId / index / expiresAt 任一都失效', () => {
    const sig = signArtifact(SECRET, 'task_1', 0, expires);
    const now = Date.now();
    expect(verifyArtifact(SECRET, 'task_2', 0, expires, sig, now)).toBe(false);
    expect(verifyArtifact(SECRET, 'task_1', 1, expires, sig, now)).toBe(false);
    expect(verifyArtifact(SECRET, 'task_1', 0, expires + 1, sig, now)).toBe(false);
  });

  it('换密钥即失效（密钥不可猜）', () => {
    const sig = signArtifact(SECRET, 'task_1', 0, expires);
    expect(verifyArtifact('y'.repeat(64), 'task_1', 0, expires, sig)).toBe(false);
  });

  it('过期链接失效，即使签名本身正确', () => {
    const past = Date.now() - 1_000;
    const sig = signArtifact(SECRET, 'task_1', 0, past);
    expect(verifyArtifact(SECRET, 'task_1', 0, past, sig)).toBe(false);
  });

  it('签名长度不符时快速失败（恒定时间比较前的廉价闸门）', () => {
    expect(verifyArtifact(SECRET, 'task_1', 0, expires, 'deadbeef')).toBe(false);
  });

  it('签名里不包含密钥明文', () => {
    const sig = signArtifact(SECRET, 'task_1', 0, expires);
    expect(sig.includes('xxxx')).toBe(false);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('artifactSecret', () => {
  it('首次生成后复用同一个密钥', async () => {
    const state = new InMemoryState();
    const rt = { state } as unknown as GatewayRuntime;
    const first = await artifactSecret(rt);
    const second = await artifactSecret(rt);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(second).toBe(first);
  });
});

describe('readArtifacts', () => {
  it('兼容历史字符串数组与结构化条目', () => {
    expect(readArtifacts(task({ artifacts: '["https://cdn/a.mp4"]' } as never))).toEqual([
      { url: 'https://cdn/a.mp4', auth: false },
    ]);
    expect(
      readArtifacts(task({ artifacts: '[{"url":"/videos/1/content","auth":true}]' } as never)),
    ).toEqual([{ url: '/videos/1/content', auth: true }]);
  });

  it('损坏数据返回空数组而不是抛错', () => {
    expect(readArtifacts(task({ artifacts: 'not-json' } as never))).toEqual([]);
    expect(readArtifacts(task({ artifacts: '{"a":1}' } as never))).toEqual([]);
    expect(readArtifacts(task({ artifacts: null } as never))).toEqual([]);
  });
});

describe('buildArtifactLinks', () => {
  it('为每个产物生成带 expires/sig 的站内链接', async () => {
    const state = new InMemoryState();
    const rt = { state } as unknown as GatewayRuntime;
    const links = await buildArtifactLinks(
      rt,
      task({ artifacts: '[{"url":"https://cdn/a.mp4","auth":false}]' } as never),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toMatch(
      /^\/llm-gateway\/artifacts\/task_1\/0\?expires=\d+&sig=[0-9a-f]{64}$/,
    );
    // 链接里不能出现上游真实地址
    expect(links[0]?.url.includes('cdn/a.mp4')).toBe(false);
  });

  it('没有产物时不签发任何链接', async () => {
    const state = new InMemoryState();
    const rt = { state } as unknown as GatewayRuntime;
    expect(await buildArtifactLinks(rt, task({ artifacts: null } as never))).toEqual([]);
  });
});
