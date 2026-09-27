// Offline only: no environment files, account credentials, bindings or provider client.
import { build } from 'esbuild';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.wrangler/diagnostics');
await mkdir(directory, { recursive: true });
const temporary = resolve(directory, `offline-adversarial-${randomUUID()}.mjs`);
try {
  const bundle = await build({ entryPoints: [resolve(root, 'scripts/adversarial-probes.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', packages: 'external', logLevel: 'silent' });
  await writeFile(temporary, bundle.outputFiles[0].text, { flag: 'wx' });
  const { runAdversarialProbes } = await import(pathToFileURL(temporary).href);
  await runAdversarialProbes(root);
} finally { await unlink(temporary).catch(() => {}); }
