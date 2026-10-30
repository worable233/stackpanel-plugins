import { describe, expect, it } from 'vitest';
import {
  clampVideoLimit,
  createVideoBodySchema,
  descriptorIdForVideoModel,
  toOpenAIVideoObject,
  toOpenAIVideoStatus,
  videoTaskParams,
} from './openai-videos.js';

const baseTask = {
  id: 'task-1',
  model: 'sora-2',
  status: 'QUEUED',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:01:00.000Z',
  requestSpec: JSON.stringify({ params: { seconds: '8', size: '1280x720' } }),
};

describe('descriptorIdForVideoModel', () => {
  it('按前缀路由到任务描述', () => {
    expect(descriptorIdForVideoModel('sora-2')).toBe('openai-video');
    expect(descriptorIdForVideoModel('Sora-2-Pro')).toBe('openai-video');
    expect(descriptorIdForVideoModel('kling-v1-6')).toBe('kling-video');
  });

  it('未知模型返回 null（不猜描述）', () => {
    expect(descriptorIdForVideoModel('veo-3')).toBeNull();
    expect(descriptorIdForVideoModel('')).toBeNull();
  });
});

describe('toOpenAIVideoStatus', () => {
  it('内部状态映射到四态', () => {
    expect(toOpenAIVideoStatus('QUEUED')).toBe('queued');
    expect(toOpenAIVideoStatus('RUNNING')).toBe('in_progress');
    expect(toOpenAIVideoStatus('SUCCEEDED')).toBe('completed');
    expect(toOpenAIVideoStatus('FAILED')).toBe('failed');
    // 对方没有第三态：取消与超时都归 failed。
    expect(toOpenAIVideoStatus('CANCELLED')).toBe('failed');
    expect(toOpenAIVideoStatus('EXPIRED')).toBe('failed');
    expect(toOpenAIVideoStatus('子系统未知状态')).toBe('queued');
  });
});

describe('toOpenAIVideoObject', () => {
  it('queued 对象带时间戳与三档进度', () => {
    const video = toOpenAIVideoObject(baseTask);
    expect(video).toMatchObject({
      id: 'task-1',
      object: 'video',
      model: 'sora-2',
      status: 'queued',
      progress: 0,
      seconds: '8',
      size: '1280x720',
      completed_at: null,
      remixed_from_video_id: null,
      error: null,
    });
    expect(video['created_at']).toBe(Math.floor(Date.parse(baseTask.createdAt) / 1000));
  });

  it('运行中 50，完成 100 且带 completed_at', () => {
    const running = toOpenAIVideoObject({ ...baseTask, status: 'RUNNING' });
    expect(running['progress']).toBe(50);
    const done = toOpenAIVideoObject({ ...baseTask, status: 'SUCCEEDED' });
    expect(done['progress']).toBe(100);
    expect(done['completed_at']).toBe(Math.floor(Date.parse(baseTask.updatedAt) / 1000));
  });

  it('失败原因用固定文案，不透传上游原文', () => {
    const failed = toOpenAIVideoObject({
      ...baseTask,
      status: 'FAILED',
      requestSpec: JSON.stringify({ params: {}, upstream: 'internal-host 500 boom' }),
    });
    expect(failed['error']).toEqual({
      code: 'video_generation_failed',
      message: '视频生成失败',
    });
    const cancelled = toOpenAIVideoObject({ ...baseTask, status: 'CANCELLED' });
    expect(cancelled['error']).toEqual({ code: 'cancelled', message: '任务已取消' });
  });

  it('requestSpec 缺失或损坏时退回默认值而不是抛错', () => {
    expect(toOpenAIVideoObject({ ...baseTask, requestSpec: null })['seconds']).toBe('8');
    expect(toOpenAIVideoObject({ ...baseTask, requestSpec: 'not json' })['size']).toBe('1280x720');
  });
});

describe('videoTaskParams', () => {
  it('OpenAI 描述直接映射 seconds/size/input_reference', () => {
    expect(
      videoTaskParams(
        {
          model: 'sora-2',
          prompt: 'a cat',
          seconds: 8,
          size: '1280x720',
          input_reference: 'https://example.com/a.png',
        },
        'openai-video',
      ),
    ).toEqual({
      prompt: 'a cat',
      seconds: '8',
      size: '1280x720',
      input_reference: 'https://example.com/a.png',
    });
  });

  it('可灵描述把 seconds/size 翻成 duration/aspectRatio', () => {
    expect(
      videoTaskParams(
        { model: 'kling-v1', prompt: 'a cat', seconds: '5', size: '720x1280' },
        'kling-video',
      ),
    ).toEqual({ prompt: 'a cat', duration: '5', aspectRatio: '9:16' });
  });

  it('认不出的 size 不传宽高比（交给上游默认值）', () => {
    expect(videoTaskParams({ model: 'kling', prompt: 'x', size: 'huge' }, 'kling-video')).toEqual({
      prompt: 'x',
    });
  });
});

describe('createVideoBodySchema / clampVideoLimit', () => {
  it('seconds 接受字符串或数字，缺 prompt 直接拒绝', () => {
    expect(
      createVideoBodySchema.safeParse({ model: 'sora-2', prompt: 'x', seconds: '8' }).success,
    ).toBe(true);
    expect(
      createVideoBodySchema.safeParse({ model: 'sora-2', prompt: 'x', seconds: 8 }).success,
    ).toBe(true);
    expect(createVideoBodySchema.safeParse({ model: 'sora-2' }).success).toBe(false);
    expect(createVideoBodySchema.safeParse({ model: 'sora-2', prompt: '' }).success).toBe(false);
  });

  it('limit 夹在 1..100，非法值回落 20', () => {
    expect(clampVideoLimit('5')).toBe(5);
    expect(clampVideoLimit('0')).toBe(1);
    expect(clampVideoLimit('1000')).toBe(100);
    expect(clampVideoLimit(undefined)).toBe(20);
    expect(clampVideoLimit('abc')).toBe(20);
  });
});
