import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDependencies } from './check-dependencies.mjs';

try {
  // Check before pnpm can touch either dependency tree.
  checkDependencies(true);
  const result = spawnSync('pnpm', ['install', ...process.argv.slice(2)], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  checkDependencies();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
