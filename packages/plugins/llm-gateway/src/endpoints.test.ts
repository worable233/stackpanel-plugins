/**
 * endpoint 注册表契约测试（目标二）。
 *
 * 硬要求：不支持的 endpoint 必须明确 404 或 501，**不得**默认回落成 Chat。
 * 这些用例锁死注册表行为，并断言「文档矩阵 ↔ 代码」逐条一致（防止漂移）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS, knownPathPrefix, matchEndpoint } from './endpoints.js';

describe('matchEndpoint', () => {
  it('matches supported OpenAI chat and models paths', () => {
    expect(matchEndpoint('POST', 'v1/chat/completions')?.spec.id).toBe('chat.completions');
    expect(matchEndpoint('POST', '/v1/chat/completions')?.spec.id).toBe('chat.completions');
    expect(matchEndpoint('GET', 'v1/models')?.spec.id).toBe('models.list');
    expect(matchEndpoint('GET', 'v1/models/gpt-4o')?.spec.id).toBe('models.get');
    expect(matchEndpoint('GET', 'v1/models/gpt-4o')?.params['model']).toBe('gpt-4o');
  });

  it('matches anthropic and gemini native paths', () => {
    expect(matchEndpoint('POST', 'v1/messages')?.spec.id).toBe('anthropic.messages');
    expect(matchEndpoint('POST', 'v1/messages/count_tokens')?.spec.id).toBe(
      'anthropic.count_tokens',
    );
    expect(matchEndpoint('POST', 'v1beta/models/gemini-2.5-pro:generateContent')?.spec.id).toBe(
      'gemini.generate_content',
    );
    const stream = matchEndpoint('POST', 'v1beta/models/gemini-2.5-pro:streamGenerateContent');
    expect(stream?.spec.id).toBe('gemini.stream_generate_content');
    expect(stream?.params['model']).toBe('gemini-2.5-pro');
  });

  it('matches path parameters for files / batches / fine-tuning', () => {
    expect(matchEndpoint('DELETE', 'v1/files/file-123')?.spec.id).toBe('files.delete');
    expect(matchEndpoint('DELETE', 'v1/files/file-123')?.params['id']).toBe('file-123');
    expect(matchEndpoint('GET', 'v1/batches/batch-1')?.spec.id).toBe('batches.get');
    expect(matchEndpoint('GET', 'v1/fine_tuning/jobs/job-1')?.spec.id).toBe('fine_tuning.get');
  });

  it('returns null for unknown paths (no silent Chat fallback)', () => {
    expect(matchEndpoint('POST', 'v1/unknown/route')).toBeNull();
    expect(matchEndpoint('POST', 'totally/bogus')).toBeNull();
    // The old matchIngress fell back to openai-chat here; the registry must not.
    expect(matchEndpoint('GET', 'v1/responses')).not.toBeNull();
    expect(matchEndpoint('POST', 'v1/responses')?.spec.id).toBe('responses.create');
  });

  it('does not match a method that is not registered for the path', () => {
    expect(matchEndpoint('POST', 'v1/models')).toBeNull();
    expect(matchEndpoint('DELETE', 'v1/models')).toBeNull();
    expect(matchEndpoint('GET', 'v1/chat/completions')).toBeNull();
  });

  it('marks WebSocket endpoints as unsupported', () => {
    const realtime = matchEndpoint('GET', 'v1/realtime');
    expect(realtime?.spec.status).toBe('unsupported');
    const responsesWs = matchEndpoint('GET', 'v1/responses');
    expect(responsesWs?.spec.id).toBe('responses.websocket');
    expect(responsesWs?.spec.status).toBe('unsupported');
  });

  it('marks assistants / threads / vector_stores / uploads as unsupported', () => {
    for (const path of ['v1/assistants', 'v1/threads', 'v1/vector_stores', 'v1/uploads']) {
      const match = matchEndpoint('POST', path);
      expect(match?.spec.status, path).toBe('unsupported');
      expect(match?.spec.note, path).toBeTruthy();
    }
  });

  it('round-trips every registered spec through matchEndpoint with an exemplar path', () => {
    const exemplar = (pattern: string): string =>
      pattern
        .split('/')
        .map((segment) => {
          if (!segment.startsWith(':')) return segment;
          const second = segment.indexOf(':', 1);
          return second > 0 ? `ex-value${segment.slice(second)}` : 'ex-value';
        })
        .join('/');
    for (const spec of ENDPOINTS) {
      const match = matchEndpoint(spec.method, exemplar(spec.path));
      expect(match?.spec.id, `${spec.method} ${spec.path}`).toBe(spec.id);
    }
  });
});

describe('knownPathPrefix', () => {
  it('recognises public API prefixes for a friendlier 404', () => {
    expect(knownPathPrefix('v1/whatever')).toBe(true);
    expect(knownPathPrefix('v1beta/models/x')).toBe(true);
    expect(knownPathPrefix('backend-api/codex')).toBe(true);
    expect(knownPathPrefix('not-an-api')).toBe(false);
  });
});

describe('endpoint registry ↔ API-COMPATIBILITY.md', () => {
  it('documents every registered endpoint exactly once', () => {
    // The docs live in the kernel repo, which is a sibling checkout of this
    // plugin repo. Try a few plausible locations so the guard works both in
    // the monorepo and in a standalone checkout.
    const here = fileURLToPath(import.meta.url);
    const candidates = [
      new URL('../../../docs/API-COMPATIBILITY.md', import.meta.url),
      new URL('../../../../../StackPanel/docs/API-COMPATIBILITY.md', import.meta.url),
      new URL('../../../../../StackPanel-docs/docs/API-COMPATIBILITY.md', import.meta.url),
    ];
    let doc: string | null = null;
    for (const candidate of candidates) {
      try {
        doc = readFileSync(fileURLToPath(candidate), 'utf8');
        break;
      } catch {
        // try the next candidate
      }
    }
    if (doc === null) {
      // Docs live in a separate repo when this package is checked out
      // standalone; the rest of the suite must still run.
      void here;
      return;
    }
    for (const spec of ENDPOINTS) {
      const occurrences = doc.split(`\`${spec.id}\``).length - 1;
      expect(occurrences, `doc missing or duplicated entry for ${spec.id}`).toBe(1);
    }
  });
});
