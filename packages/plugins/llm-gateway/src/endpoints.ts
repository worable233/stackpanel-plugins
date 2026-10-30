/**
 * 公网 endpoint 注册表。
 *
 * 目标二的硬要求：**不支持的 endpoint 必须明确返回 404 或 501，不能默认当作
 * Chat 请求转发**。旧实现（`@stackpanel/llm-protocol` 的 `matchIngress`）在路径不匹配时
 * 一律回落到 openai-chat 并把路径原样拼到上游 baseUrl —— 于是
 * `POST /llm-gateway/v1/embeddings` 会被当成 chat 打到 `…/v1/embeddings`，
 * 上游返回的 404 再被包装成一个语焉不详的 `upstream_error`。注册表把这件事
 * 变成显式状态：命中 → 按 spec 处理；路径存在但本实现不支持 → 501；
 * 路径不存在 → 404（OpenAI 的 `not_found_error`）。
 *
 * 每个 spec 声明：
 * - `family`：协议族，决定用哪套 IR/codec 或哪个非对话 operation handler。
 * - `bodyKind`：请求体形态（json / multipart / binary / none / websocket），
 *   决定 body 读取策略与大小上限。
 * - `responseKind`：响应形态（json / sse / binary / none），决定写出策略
 *   （二进制必须流式，不能整体缓冲进内存）。
 * - `status`：`supported` | `unsupported`（明确 501）| `reserved`（明确 404+说明）。
 */

/** 请求体形态。 */
export type BodyKind = 'json' | 'multipart' | 'binary' | 'none';

/** 响应形态。 */
export type ResponseKind = 'json' | 'sse' | 'binary' | 'websocket' | 'none';

/** 协议族：决定走 IR（对话类）还是 operation handler（非对话类）。 */
export type EndpointFamily =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'openai-embeddings'
  | 'openai-images'
  | 'openai-audio'
  | 'openai-moderations'
  | 'openai-rerank'
  | 'openai-files'
  | 'openai-batches'
  | 'openai-fine-tuning'
  | 'openai-realtime'
  | 'meta';

/** 非对话操作种类（adaptor 按此声明自己支持哪些）。 */
export type OperationKind =
  | 'embeddings'
  | 'images.generations'
  | 'images.edits'
  | 'audio.speech'
  | 'audio.transcriptions'
  | 'audio.translations'
  | 'moderations'
  | 'rerank'
  | 'files.list'
  | 'files.create'
  | 'files.delete'
  | 'batches.create'
  | 'batches.get'
  | 'fine_tuning.create'
  | 'fine_tuning.get';

export interface EndpointSpec {
  /** 稳定标识，用于指标与文档矩阵。 */
  id: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  /** 相对 `/llm-gateway/` 的路径模式（已去掉前导斜杠）。 */
  path: string;
  family: EndpointFamily;
  bodyKind: BodyKind;
  responseKind: ResponseKind;
  status: 'supported' | 'unsupported' | 'reserved';
  /** 非对话操作；对话类为 undefined（走 IR）。 */
  operation?: OperationKind;
  /** 不支持时的说明（进 error.message，便于运维定位）。 */
  note?: string;
  /** 请求体上限（字节）。覆盖全局默认。 */
  bodyLimit?: number;
  /** 路径里是否含 `:id` 之类的参数。 */
  params?: readonly string[];
}

/**
 * 注册表。**顺序即优先级**（同名路径只应出现一次）。
 *
 * 每条都在文档 `docs/API-COMPATIBILITY.md` 的实现矩阵里有对应一行 —— 该表由
 * 本文件导出，测试会断言两边一致（防止「文档说支持、代码没实现」）。
 */
export const ENDPOINTS: readonly EndpointSpec[] = [
  /* ------------------------------ OpenAI 对话 ------------------------------ */
  {
    id: 'chat.completions',
    method: 'POST',
    path: 'v1/chat/completions',
    family: 'openai-chat',
    bodyKind: 'json',
    responseKind: 'json', // 实际可为 sse（body.stream=true），写出策略在运行时判定
    status: 'supported',
  },
  {
    id: 'responses.create',
    method: 'POST',
    path: 'v1/responses',
    family: 'openai-responses',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
  },
  {
    id: 'models.list',
    method: 'GET',
    path: 'v1/models',
    family: 'meta',
    bodyKind: 'none',
    responseKind: 'json',
    status: 'supported',
  },
  {
    id: 'models.get',
    method: 'GET',
    path: 'v1/models/:model',
    family: 'meta',
    bodyKind: 'none',
    responseKind: 'json',
    status: 'supported',
    params: ['model'],
  },

  /* ------------------------------ Anthropic ------------------------------ */
  {
    id: 'anthropic.messages',
    method: 'POST',
    path: 'v1/messages',
    family: 'anthropic',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
  },
  {
    id: 'anthropic.count_tokens',
    method: 'POST',
    path: 'v1/messages/count_tokens',
    family: 'anthropic',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
  },

  /* ------------------------------ Gemini ------------------------------ */
  {
    id: 'gemini.generate_content',
    method: 'POST',
    path: 'v1beta/models/:model:generateContent',
    family: 'gemini',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    params: ['model'],
  },
  {
    id: 'gemini.stream_generate_content',
    method: 'POST',
    path: 'v1beta/models/:model:streamGenerateContent',
    family: 'gemini',
    bodyKind: 'json',
    responseKind: 'sse',
    status: 'supported',
    params: ['model'],
  },
  {
    id: 'gemini.embed_content',
    method: 'POST',
    path: 'v1beta/models/:model:embedContent',
    family: 'gemini',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    params: ['model'],
    operation: 'embeddings',
  },
  {
    id: 'gemini.batch_embed_contents',
    method: 'POST',
    path: 'v1beta/models/:model:batchEmbedContents',
    family: 'gemini',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    params: ['model'],
    operation: 'embeddings',
  },

  /* ------------------------------ OpenAI embeddings ------------------------------ */
  {
    id: 'embeddings.create',
    method: 'POST',
    path: 'v1/embeddings',
    family: 'openai-embeddings',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    operation: 'embeddings',
  },

  /* ------------------------------ 图片 ------------------------------ */
  {
    id: 'images.generations',
    method: 'POST',
    path: 'v1/images/generations',
    family: 'openai-images',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    operation: 'images.generations',
  },
  {
    id: 'images.edits',
    method: 'POST',
    path: 'v1/images/edits',
    family: 'openai-images',
    bodyKind: 'multipart',
    responseKind: 'json',
    status: 'supported',
    operation: 'images.edits',
    bodyLimit: 32 * 1024 * 1024,
  },

  /* ------------------------------ 音频 ------------------------------ */
  {
    id: 'audio.speech',
    method: 'POST',
    path: 'v1/audio/speech',
    family: 'openai-audio',
    bodyKind: 'json',
    responseKind: 'binary',
    status: 'supported',
    operation: 'audio.speech',
  },
  {
    id: 'audio.transcriptions',
    method: 'POST',
    path: 'v1/audio/transcriptions',
    family: 'openai-audio',
    bodyKind: 'multipart',
    responseKind: 'json',
    status: 'supported',
    operation: 'audio.transcriptions',
    bodyLimit: 64 * 1024 * 1024,
  },
  {
    id: 'audio.translations',
    method: 'POST',
    path: 'v1/audio/translations',
    family: 'openai-audio',
    bodyKind: 'multipart',
    responseKind: 'json',
    status: 'supported',
    operation: 'audio.translations',
    bodyLimit: 64 * 1024 * 1024,
  },

  /* ------------------------------ 审核 / 重排 ------------------------------ */
  {
    id: 'moderations.create',
    method: 'POST',
    path: 'v1/moderations',
    family: 'openai-moderations',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    operation: 'moderations',
  },
  {
    id: 'rerank.create',
    method: 'POST',
    path: 'v1/rerank',
    family: 'openai-rerank',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    operation: 'rerank',
  },

  /* ------------------------------ 文件 ------------------------------ */
  {
    id: 'files.list',
    method: 'GET',
    path: 'v1/files',
    family: 'openai-files',
    bodyKind: 'none',
    responseKind: 'json',
    status: 'supported',
    operation: 'files.list',
  },
  {
    id: 'files.create',
    method: 'POST',
    path: 'v1/files',
    family: 'openai-files',
    bodyKind: 'multipart',
    responseKind: 'json',
    status: 'supported',
    operation: 'files.create',
    bodyLimit: 512 * 1024 * 1024,
  },
  {
    id: 'files.delete',
    method: 'DELETE',
    path: 'v1/files/:id',
    family: 'openai-files',
    bodyKind: 'none',
    responseKind: 'json',
    status: 'supported',
    operation: 'files.delete',
    params: ['id'],
  },

  /* ------------------------------ 批处理 ------------------------------ */
  {
    id: 'batches.create',
    method: 'POST',
    path: 'v1/batches',
    family: 'openai-batches',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    operation: 'batches.create',
  },
  {
    id: 'batches.get',
    method: 'GET',
    path: 'v1/batches/:id',
    family: 'openai-batches',
    bodyKind: 'none',
    responseKind: 'json',
    status: 'supported',
    operation: 'batches.get',
    params: ['id'],
  },

  /* ------------------------------ 微调 ------------------------------ */
  {
    id: 'fine_tuning.create',
    method: 'POST',
    path: 'v1/fine_tuning/jobs',
    family: 'openai-fine-tuning',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'supported',
    operation: 'fine_tuning.create',
  },
  {
    id: 'fine_tuning.get',
    method: 'GET',
    path: 'v1/fine_tuning/jobs/:id',
    family: 'openai-fine-tuning',
    bodyKind: 'none',
    responseKind: 'json',
    status: 'supported',
    operation: 'fine_tuning.get',
    params: ['id'],
  },

  /* ------------------------------ 实时 / WebSocket ------------------------------ */
  // 内核 SDK 没有暴露 HTTP `upgrade` 事件：`PluginRoute['kind']` 只有 `'handler'`
  // 与 `'raw'` 两种，raw 路由拿到的是已经解析完的普通请求，插件拿不到握手时刻，
  // 因此无法做 WebSocket 双向转发。这里显式标 unsupported 并给 501，而不是
  // 假装支持、把 Upgrade 请求当普通 GET 处理（那会给客户端一个语焉不详的 200）。
  // 真正支持需要内核侧新增 upgrade 通道，属跨内核改动，本期不做。
  {
    id: 'realtime.session',
    method: 'GET',
    path: 'v1/realtime',
    family: 'openai-realtime',
    bodyKind: 'none',
    responseKind: 'websocket',
    status: 'unsupported',
    note: 'Realtime WebSocket 未实现：内核尚未向插件暴露 HTTP upgrade 通道；请改用 /v1/chat/completions 或 /v1/responses 的 SSE 流式',
  },
  {
    id: 'responses.websocket',
    method: 'GET',
    path: 'v1/responses',
    family: 'openai-realtime',
    bodyKind: 'none',
    responseKind: 'websocket',
    status: 'unsupported',
    note: 'Responses WebSocket 未实现：内核尚未向插件暴露 HTTP upgrade 通道；请改用 POST /v1/responses 的 SSE 流式',
  },

  /* ------------------------------ 明确保留 / 不支持 ------------------------------ */
  // 路径存在于 OpenAI 生态、但本网关本期不做：显式 501，便于客户端与运维区分
  // 「我打错路径了」（404）与「平台还没实现」（501）。
  {
    id: 'assistants.create',
    method: 'POST',
    path: 'v1/assistants',
    family: 'meta',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'unsupported',
    note: 'Assistants API 未实现；请改用 /v1/responses 或 /v1/chat/completions',
  },
  {
    id: 'threads.create',
    method: 'POST',
    path: 'v1/threads',
    family: 'meta',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'unsupported',
    note: 'Assistants/Threads API 未实现；请改用 /v1/responses',
  },
  {
    id: 'vector_stores.create',
    method: 'POST',
    path: 'v1/vector_stores',
    family: 'meta',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'unsupported',
    note: 'Vector Stores API 未实现',
  },
  {
    id: 'uploads.create',
    method: 'POST',
    path: 'v1/uploads',
    family: 'meta',
    bodyKind: 'json',
    responseKind: 'json',
    status: 'unsupported',
    note: '分片上传 API 未实现；请用 /v1/files 一次上传',
  },
] as const;

export interface EndpointMatch {
  spec: EndpointSpec;
  params: Record<string, string>;
}

/** 把 spec.path 拆成段（`:name` 为参数段）。 */
function segments(pattern: string): string[] {
  return pattern.split('/').filter((part) => part.length > 0);
}

/**
 * 匹配请求路径。规则：
 * - 段数必须相等；
 * - `:name` 段匹配任意非空段并捕获；
 * - `:model:xxx` 形态（Gemini 的 `models/{model}:{action}`）作为**整体字面+参数**
 *   处理：spec 里写作 `:model:generateContent`，实现上拆成 `{ param: 'model',
 *   suffix: ':generateContent' }`。
 * - 字面段精确匹配。
 */
export function matchEndpoint(method: string, rest: string): EndpointMatch | null {
  const path = rest.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = path.length === 0 ? [] : path.split('/');

  for (const spec of ENDPOINTS) {
    if (spec.method !== method) continue;
    const pattern = segments(spec.path);
    if (pattern.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i += 1) {
      const pat = pattern[i] as string;
      const value = parts[i] as string;
      if (pat.startsWith(':')) {
        // `:model:generateContent` → param 'model' + 字面后缀 ':generateContent'
        const secondColon = pat.indexOf(':', 1);
        if (secondColon > 0) {
          const name = pat.slice(1, secondColon);
          const suffix = pat.slice(secondColon);
          if (!value.endsWith(suffix)) {
            ok = false;
            break;
          }
          const captured = value.slice(0, value.length - suffix.length);
          if (captured.length === 0) {
            ok = false;
            break;
          }
          params[name] = decodeURIComponent(captured);
        } else {
          const name = pat.slice(1);
          if (value.length === 0) {
            ok = false;
            break;
          }
          params[name] = decodeURIComponent(value);
        }
      } else if (pat !== value) {
        ok = false;
        break;
      }
    }
    if (ok) return { spec, params };
  }
  return null;
}

/** 允许的入口路径前缀（`/llm-gateway/` 之后）。用于给出更好的 404 提示。 */
export function knownPathPrefix(rest: string): boolean {
  const path = rest.replace(/^\/+/, '');
  return (
    path.startsWith('v1/') ||
    path.startsWith('v1beta/') ||
    path === 'v1' ||
    path.startsWith('backend-api/')
  );
}
