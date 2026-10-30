/**
 * 异步任务框架（C1）契约测试。
 *
 * 这一层刻意**不含网络与 DB**：描述是纯数据，解释器是纯函数。所有厂商差异都被
 * 压进 `BUILTIN_TASK_DESCRIPTORS`，所以只要这几条不变量成立，新增一个厂商就
 * 只是加一条数据 + 一个 fixture，不需要碰执行器。
 */
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TASK_DESCRIPTORS,
  classifyTaskStatus,
  collectArtifacts,
  fillBody,
  fillTemplate,
  getTaskDescriptor,
  readPath,
  registerTaskDescriptor,
  validateTaskDescriptor,
  type TaskDescriptor,
} from './tasks.js';

function descriptor(over: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    id: 'test-video',
    label: 'Test',
    kind: 'video',
    submit: { path: '/videos', body: { model: '{model}', prompt: '{prompt}' } },
    idPath: 'id',
    poll: {
      path: '/videos/{upstreamId}',
      method: 'GET',
      statusPath: 'status',
      done: ['completed'],
      fail: ['failed'],
      intervalMs: 1_000,
      maxAttempts: 10,
    },
    artifacts: { urlPaths: [], endpointTemplates: ['/videos/{upstreamId}/content'] },
    billing: { unit: 'call' },
    params: ['prompt'],
    ttlMs: 60_000,
    ...over,
  };
}

describe('内置任务描述', () => {
  it('全部通过静态校验', () => {
    for (const builtin of BUILTIN_TASK_DESCRIPTORS) {
      expect(validateTaskDescriptor(builtin), builtin.id).toBeNull();
    }
  });

  it('lookup 忽略首尾空白，未知 id 返回 null', () => {
    expect(getTaskDescriptor(' openai-video ')?.id).toBe('openai-video');
    expect(getTaskDescriptor('nope')).toBeNull();
  });
});

describe('validateTaskDescriptor', () => {
  it('拒绝不覆盖轮询窗口的 TTL', () => {
    // interval 1000ms × 10 次 + 60s 余量 = 70s，TTL 60s 不够。
    expect(validateTaskDescriptor(descriptor())).toContain('冻结 TTL');
  });

  it('拒绝没有任何产物来源的描述', () => {
    const error = validateTaskDescriptor(
      descriptor({ ttlMs: 300_000, artifacts: { urlPaths: [], endpointTemplates: [] } }),
    );
    expect(error).toContain('产物');
  });

  it('拒绝相对路径之外的提交路径', () => {
    const error = validateTaskDescriptor(
      descriptor({ ttlMs: 300_000, submit: { path: 'videos', body: {} } }),
    );
    expect(error).toContain('/');
  });
});

describe('fillTemplate', () => {
  it('替换全部占位', () => {
    expect(fillTemplate('/videos/{upstreamId}', { upstreamId: 'vid_1' })).toBe('/videos/vid_1');
  });

  it('缺变量时返回 null（否则会把字面量 {seconds} 发给上游）', () => {
    expect(fillTemplate('/videos/{upstreamId}', {})).toBeNull();
    expect(fillTemplate('/v/{model}?s={seconds}', { model: 'sora-2' })).toBeNull();
  });

  it('空串按缺失处理', () => {
    expect(fillTemplate('/v/{upstreamId}', { upstreamId: '' })).toBeNull();
  });
});

describe('fillBody', () => {
  it('缺变量的键整条省略，而不是写空串', () => {
    const body = fillBody(
      { model: '{model}', prompt: '{prompt}', seconds: '{seconds}' },
      {
        model: 'sora-2',
        prompt: '一只猫',
      },
    );
    expect(body).toEqual({ model: 'sora-2', prompt: '一只猫' });
  });

  it('非字符串值原样保留', () => {
    expect(fillBody({ n: 1, flag: true }, {})).toEqual({ n: 1, flag: true });
  });
});

describe('readPath', () => {
  it('支持嵌套对象与数组下标', () => {
    const payload = { data: { task_result: { videos: [{ url: 'https://cdn/1.mp4' }] } } };
    expect(readPath(payload, 'data.task_result.videos.0.url')).toBe('https://cdn/1.mp4');
  });

  it('路径不存在或越界时返回 undefined（不抛）', () => {
    expect(readPath(null, 'a.b')).toBeUndefined();
    expect(readPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(readPath({ list: [] }, 'list.3')).toBeUndefined();
    expect(readPath({ list: [] }, 'list.x')).toBeUndefined();
    expect(readPath({}, '')).toBeUndefined();
  });
});

describe('classifyTaskStatus', () => {
  const poll = { done: ['completed', 'succeed'], fail: ['failed'] };

  it('大小写不敏感命中成功/失败词', () => {
    expect(classifyTaskStatus('COMPLETED', poll)).toBe('SUCCEEDED');
    expect(classifyTaskStatus(' Failed ', poll)).toBe('FAILED');
  });

  it('未知状态与空值一律视为进行中（不能把未知状态当失败退款）', () => {
    expect(classifyTaskStatus('queued', poll)).toBe('RUNNING');
    expect(classifyTaskStatus(undefined, poll)).toBe('RUNNING');
    expect(classifyTaskStatus(42, poll)).toBe('RUNNING');
  });
});

describe('collectArtifacts', () => {
  it('公开 URL 与端点模板分开标记', () => {
    const builtin = getTaskDescriptor('openai-video');
    expect(builtin).not.toBeNull();
    const artifacts = collectArtifacts(builtin!, { id: 'vid_1', status: 'completed' }, 'vid_1');
    expect(artifacts).toEqual([{ url: '/videos/vid_1/content', auth: true }]);
  });

  it('厂商直接返回 CDN 链接时不走代理（auth=false）', () => {
    const kling = getTaskDescriptor('kling-video');
    expect(kling).not.toBeNull();
    const artifacts = collectArtifacts(
      kling!,
      { data: { task_result: { videos: [{ url: 'https://cdn/k.mp4' }] } } },
      'task_1',
    );
    expect(artifacts).toEqual([{ url: 'https://cdn/k.mp4', auth: false }]);
  });

  it('产物字段缺失时返回空数组', () => {
    const kling = getTaskDescriptor('kling-video');
    expect(collectArtifacts(kling!, { data: {} }, 'task_1')).toEqual([]);
  });
});

describe('registerTaskDescriptor', () => {
  it('非法描述当场抛出（不要把坏数据留到运行时）', () => {
    expect(() => registerTaskDescriptor(descriptor({ id: 'broken', ttlMs: 1 }))).toThrowError(
      /invalid task descriptor/,
    );
  });

  it('合法描述可注册并按 id 覆盖', () => {
    const good = descriptor({ id: 'custom-ok', ttlMs: 300_000 });
    registerTaskDescriptor(good);
    expect(getTaskDescriptor('custom-ok')?.label).toBe('Test');
  });
});
