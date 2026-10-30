/**
 * Serialize the shipped catalogs into `frontend/manifest.json`.
 *
 * The host reads package copy from the manifest (ADR-0016 §5) — the JSON files
 * under `frontend/messages/` are the authored source and the gate that checks
 * key parity reads those, so the two must not drift. Regenerating the block from
 * the files on every build makes that impossible instead of a review habit.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const messagesDir = path.join(root, 'frontend', 'messages');
const manifestPath = path.join(root, 'frontend', 'manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const messages = {};
for (const file of readdirSync(messagesDir).sort()) {
  if (!file.endsWith('.json')) continue;
  const locale = file.slice(0, -'.json'.length);
  messages[locale] = JSON.parse(readFileSync(path.join(messagesDir, file), 'utf8'));
}

// Keep the declared locales and the serialized block in step; a locale that is
// offered but missing from the block renders key names at runtime.
manifest.locales = Object.keys(messages);
manifest.messages = messages;

const next = `${JSON.stringify(manifest, null, 2)}\n`;
const previous = readFileSync(manifestPath, 'utf8');
if (previous !== next) writeFileSync(manifestPath, next);
console.log(`[sync-messages] manifest.json <- ${Object.keys(messages).join(', ')}`);
