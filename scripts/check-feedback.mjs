#!/usr/bin/env node
/**
 * 反馈契约门禁（对应内核 `docs/design/feedback-ux-handoff.md`）。
 *
 * 内核仓库有四个 vitest 守门测试，但它们只扫 `packages/plugins/*`（内核内置包）。
 * 本仓库的插件在内核之外，长期是盲区 —— 审计点名的问题全是这里漏掉的。
 *
 * 本脚本只做纯文本 / manifest 检查，不依赖 typescript，也不要求 `pnpm install`
 * 之后才能跑（CI 只装 `opencc-js`，与 `check-package-catalogs.mjs` 同样的约束）。
 *
 * 规则：
 *
 *   1. **不泄漏原文** — `toast.*(...)` / `setError(...)` 的参数里不得出现
 *      `*.message`（`fetch failed`、`SignatureDoesNotMatch`、上游 SQL 片段……）。
 *      只认已本地化文案；原始异常进 `console.error`。
 *      例外：`result.message` / `response.message` 这类已本地化的动作回执（白名单）。
 *   2. **成功必须有回执** — 每个 `POST`/`PATCH`/`DELETE` action 必须
 *      **恰好** 声明 `successFeedback` xor `silent`。
 *
 * 用法：
 *   node scripts/check-feedback.mjs          # 报告 + 有违规则 exit 1
 *   node scripts/check-feedback.mjs --json   # 机器可读
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');

/**
 * 与内核 `apps/web/tests/feedback-no-raw-message.test.ts` 保持同一规则。
 *
 * 旧版是 `(?:cause|error|err|…)` 大小写敏感 alternation，漏掉了 `loadError.message`
 * 这种驼峰绑定（外部插件全用的这种写法），所以这里按「错误味标识符」匹配。
 */
const RAW_MESSAGE_CALL =
  /(?:toast\.[A-Za-z]+|setError)\s*\([^;\n]*(?:\b(?:e|err|cause)\b|[A-Za-z_$]*(?:[Ee]rr(?:or)?|[Cc]ause|[Ff]ailure|[Ee]xception))\.message\b/;

/** 已本地化的动作回执，允许出现在反馈通道里。 */
const ALLOWED_RECEIVER = /\b(result|response|res|data|payload|feedback|body)\?*\.message\b/;

/** 测试、夹具、构建产物不是线上反馈代码。 */
const SKIP_PATH = /(^|\/)(node_modules|dist|\.next|tests?|__tests__|fixtures?)(\/|$)/;

const MUTATING = new Set(['POST', 'PATCH', 'DELETE']);

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((full) => statSync(full).isDirectory());
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_PATH.test(path.relative(root, full))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

/** 所有需要检查的前端源码根：内置插件 + （若有）主题。 */
function frontendSources() {
  const sources = [];
  for (const base of ['packages/plugins', 'packages/themes']) {
    for (const dir of listDirs(path.join(root, base))) {
      const src = path.join(dir, 'frontend', 'src');
      if (existsSync(src)) sources.push(src);
    }
  }
  return sources;
}

function frontendManifests() {
  const manifests = [];
  for (const dir of listDirs(path.join(root, 'packages', 'plugins'))) {
    const manifest = path.join(dir, 'frontend', 'manifest.json');
    if (existsSync(manifest)) manifests.push(manifest);
  }
  return manifests;
}

const problems = [];

function checkRawMessages() {
  for (const src of frontendSources()) {
    const files = [];
    walk(src, files);
    for (const file of files) {
      const relative = path.relative(root, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!RAW_MESSAGE_CALL.test(line)) return;
          if (ALLOWED_RECEIVER.test(line)) return;
          problems.push({
            rule: 'raw-message',
            where: `${relative}:${index + 1}`,
            detail: line.trim(),
          });
        });
    }
  }
}

function checkActionFeedback() {
  for (const file of frontendManifests()) {
    const relative = path.relative(root, file);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push({ rule: 'manifest', where: relative, detail: `unparsable: ${error.message}` });
      continue;
    }
    for (const action of manifest.actions ?? []) {
      if (!MUTATING.has(action.method)) continue;
      const hasFeedback = Boolean(action.successFeedback);
      const hasSilent = action.silent === true;
      if (hasFeedback !== hasSilent) continue;
      problems.push({
        rule: 'action-feedback',
        where: `${relative} ${action.id ?? '<anonymous>'}`,
        detail: hasFeedback
          ? '同时声明了 successFeedback 与 silent（会重复提示）'
          : '既无 successFeedback 也无 silent（成功静默）',
      });
    }
  }
}

checkRawMessages();
checkActionFeedback();

if (json) {
  console.log(JSON.stringify({ problems }, null, 2));
} else if (problems.length === 0) {
  console.log(`ok  ${frontendSources().length} 个前端包：反馈通道无原文、写操作均有回执`);
} else {
  for (const problem of problems) {
    const label = problem.rule === 'raw-message' ? 'RAW-MESSAGE' : 'ACTION-FEEDBACK';
    console.error(`${label}  ${problem.where}\n              ${problem.detail}`);
  }
  console.error(
    `\n${problems.length} 个反馈契约问题。原文只许进 console.error，界面文案按 key 查（ADR-0016）。`,
  );
}

process.exit(problems.length === 0 ? 0 : 1);
