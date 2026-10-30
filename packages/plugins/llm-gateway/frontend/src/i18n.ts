import { createPackageTranslator } from '@stackpanel/sdk';
import enUS from '../messages/en-US.json';
import zhCN from '../messages/zh-CN.json';
import zhTW from '../messages/zh-TW.json';
import zhHK from '../messages/zh-HK.json';
import jaJP from '../messages/ja-JP.json';
import koKR from '../messages/ko-KR.json';
import frFR from '../messages/fr-FR.json';

/**
 * Package-local catalogs (ADR-0016 §5).
 *
 * Catalogs live outside `src/` because they are message data, not code. Keys are
 * flat and package-local: they are never merged into the kernel catalog.
 */
export const messages = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  'en-US': enUS,
  // ja-JP / ko-KR / fr-FR 先接线：未翻译的键在 catalog 文件里以英文兜底（不是运行时
  // 回退），避免「日语界面里冒出中文」。翻译按 nav / common / admin.playground
  // 这类分组推进，缺的继续保持英文。
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'fr-FR': frFR,
} as const;

export const t = (locale?: string) => createPackageTranslator(locale, messages, ['zh-CN']);
