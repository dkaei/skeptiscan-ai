// Offline: node scripts/run-live-screenshot-smoke.mjs --build-only
// Paid, deliberate: node scripts/run-live-screenshot-smoke.mjs --run-live --fixture screenshot.png
// Wrangler reads local .dev.vars. Never put a key in arguments or chat.
import { build } from 'esbuild';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const root = fileURLToPath(new URL('../', import.meta.url));
const buildOnly = args.length === 1 && args[0] === '--build-only';
const deliberate = args.length === 3 && args[0] === '--run-live' && args[1] === '--fixture'
  && ['screenshot.png', 'screenshot.jpg', 'screenshot-obscured.png'].includes(args[2]);
if (!buildOnly && !deliberate) {
  console.error('Use --build-only for offline validation, or --run-live --fixture screenshot.png (screenshot.jpg / screenshot-obscured.png).');
  process.exitCode = 2;
} else {
  let temporary;
  try {
    const result = await build({ entryPoints: [resolve(root, 'scripts/live-screenshot-smoke.ts')],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', packages: 'external', logLevel: 'silent' });
    if (buildOnly) console.log('Diagnostic bundle compiled. No bindings, credentials or live requests accessed.');
    else {
      // Keep the compiled module under the app so external packages resolve locally.
      const directory = resolve(root, '.wrangler/diagnostics');
      await mkdir(directory, { recursive: true });
      temporary = resolve(directory, `screenshot-smoke-${randomUUID()}.mjs`);
      await writeFile(temporary, result.outputFiles[0].text, { flag: 'wx' });
      process.chdir(root);
      const { runLiveScreenshotSmoke } = await import(pathToFileURL(temporary).href);
      await runLiveScreenshotSmoke(args, root);
    }
  } catch (error) {
    const code = error && typeof error === 'object' && typeof error.code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'diagnostic_failed';
    console.error(`Screenshot diagnostic stopped: ${code}. No raw error or environment was printed.`);
    process.exitCode = 1;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
