/**
 * OpenAI Videos 兼容面（`POST/GET/DELETE /v1/videos`）。
 *
 * 内部任务框架（`tasks.ts`）存的是自家 `GatewayTask` 行；这一层只做**投影**：把
 * 行翻译成 OpenAI 的 video 对象。做投影而不是新写一套任务存储的理由很直接——
 * 提交、轮询、产物签名、结算、取消都已经在任务框架里跑通并有单测，重写一遍只会
 * 多一条会漂移的代码路径。
 *
 * 兼容面的取舍（刻意的偏离，都写在这里而不是藏着）：
 * - `input_reference` 收 **URL 字符串**，不收 multipart 文件：网关不打算做文件
 *   上传中转（Sora 的原生接口要 multipart，那是另一套存储与配额问题）。
 * - `progress` 只有 0 / 50 / 100 三档：上游不提供百分比，编造中间值等于撒谎。
 * - 失败原因不透传上游原文，只给固定的 `code` + 中文文案。
 */
import { z } from 'zod';

/** 模型前缀 → 任务描述 id。未知模型直接拒绝，而不是猜一个描述去提交。 */
const MODEL_ROUTES: ReadonlyArray<{ prefix: string; descriptorId: string }> = [
  { prefix: 'sora', descriptorId: 'openai-video' },
  { prefix: 'kling', descriptorId: 'kling-video' },
];

export function descriptorIdForVideoModel(model: string): string | null {
  const name = model.trim().toLowerCase();
  for (const route of MODEL_ROUTES) {
    if (name.startsWith(route.prefix)) return route.descriptorId;
  }
  return null;
}

export const createVideoBodySchema = z.object({
  model: z.string().trim().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  /** OpenAI 允许字符串或数字（`"8"` / `8`）。 */
  seconds: z.union([z.string().trim().max(8), z.number()]).optional(),
  size: z.string().trim().max(32).optional(),
  /** 起始帧参考图：这里接受 URL（见文件头说明）。 */
  input_reference: z.string().trim().max(2048).optional(),
});

export type CreateVideoBody = z.infer<typeof createVideoBodySchema>;

export type OpenAIVideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface OpenAIVideoError {
  code: string;
  message: string;
}

/** 内部状态 → OpenAI 状态。`CANCELLED` / `EXPIRED` 都归到 `failed`（对方没有第三态）。 */
export function toOpenAIVideoStatus(status: string): OpenAIVideoStatus {
  switch (status) {
    case 'SUCCEEDED':
      return 'completed';
    case 'RUNNING':
      return 'in_progress';
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'failed';
    default:
      return 'queued';
  }
}

/** 三档进度（上游不给百分比）。 */
function progressOf(status: string): number {
  const mapped = toOpenAIVideoStatus(status);
  if (mapped === 'completed') return 100;
  if (mapped === 'in_progress') return 50;
  return 0;
}

/**
 * 失败原因：只用固定文案。
 *
 * `task.error` 里可能带上游返回的片段（可能是英文堆栈或内部主机名），直接回给
 * 调用方既不友好也漏内部信息。
 */
function errorOf(status: string): OpenAIVideoError | null {
  if (status === 'CANCELLED') return { code: 'cancelled', message: '任务已取消' };
  if (status === 'EXPIRED') return { code: 'expired', message: '任务已超时' };
  if (status === 'FAILED') return { code: 'video_generation_failed', message: '视频生成失败' };
  return null;
}

export interface VideoTaskLike {
  id: string;
  model?: string | null;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  requestSpec?: string | null;
}

function paramsOf(task: VideoTaskLike): Record<string, unknown> {
  if (!task.requestSpec) return {};
  try {
    const parsed = JSON.parse(task.requestSpec) as unknown;
    if (parsed && typeof parsed === 'object') {
      const params = (parsed as Record<string, unknown>)['params'];
      if (params && typeof params === 'object') return params as Record<string, unknown>;
    }
  } catch {
    /* 坏 JSON 当作没有参数：投影不该因为一行脏数据而 500。 */
  }
  return {};
}

function secondsOf(task: VideoTaskLike): string {
  const raw = paramsOf(task)['seconds'] ?? paramsOf(task)['duration'];
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return '8';
}

function unixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 任务行 → OpenAI video 对象。 */
export function toOpenAIVideoObject(task: VideoTaskLike): Record<string, unknown> {
  const status = toOpenAIVideoStatus(task.status);
  const params = paramsOf(task);
  const size = typeof params['size'] === 'string' ? params['size'] : '1280x720';
  return {
    id: task.id,
    object: 'video',
    model: task.model ?? '',
    status,
    progress: progressOf(task.status),
    created_at: unixSeconds(task.createdAt) ?? 0,
    completed_at: status === 'completed' ? unixSeconds(task.updatedAt) : null,
    expires_at: null,
    seconds: secondsOf(task),
    size,
    remixed_from_video_id: null,
    error: errorOf(task.status),
  };
}

/** `size`（像素）→ 可灵要的宽高比。认不出就不传，让上游用默认值。 */
function aspectRatioOf(size: string): string | null {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match || !match[1] || !match[2]) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.02) return '1:1';
  return ratio > 1 ? '16:9' : '9:16';
}

/**
 * 兼容面参数 → 任务描述参数。
 *
 * 两家描述的参数名不同（`seconds`/`size` vs `duration`/`aspectRatio`），在这里
 * 翻译一次，而不是让任务框架认识 OpenAI 的字段名。
 */
export function videoTaskParams(
  body: CreateVideoBody,
  descriptorId: string,
): Record<string, string> {
  const params: Record<string, string> = { prompt: body.prompt };
  const seconds = body.seconds === undefined ? undefined : String(body.seconds);
  if (descriptorId === 'kling-video') {
    if (seconds) params['duration'] = seconds;
    if (body.size) {
      const ratio = aspectRatioOf(body.size);
      if (ratio) params['aspectRatio'] = ratio;
    }
    return params;
  }
  if (seconds) params['seconds'] = seconds;
  if (body.size) params['size'] = body.size;
  if (body.input_reference) params['input_reference'] = body.input_reference;
  return params;
}

/** `GET /v1/videos` 的列表封装（`limit` 上限 100，与 OpenAI 一致）。 */
export function clampVideoLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 20;
  if (!Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}
