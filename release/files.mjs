import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_ROOTS = ['src', 'server', 'shared', 'public', 'migrations', 'tests', 'release', 'scripts'];
export const SOURCE_FILES = ['package.json', 'package-lock.json', 'wrangler.jsonc', 'index.html', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts'];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const portable = (value) => value.replaceAll('\\', '/');

export async function walkFiles(root, relative) {
  const absolute = path.resolve(root, relative);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not permitted in release inputs: ${relative}`);
  if (stat.isFile()) return [portable(relative)];
  if (!stat.isDirectory()) throw new Error(`Unsupported release input: ${relative}`);
  const entries = await readdir(absolute);
  const groups = await Promise.all(entries.sort().map((entry) => walkFiles(root, path.join(relative, entry))));
  return groups.flat();
}

export async function fingerprint(root, relativeFiles) {
  const files = {};
  for (const file of [...new Set(relativeFiles)].sort()) {
    const stat = await lstat(path.resolve(root, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular release file: ${file}`);
    files[portable(file)] = sha256(await readFile(path.resolve(root, file)));
  }
  return { hash: sha256(JSON.stringify(files)), files };
}

export async function sourceFingerprint(root) {
  const files = [...SOURCE_FILES];
  for (const directory of SOURCE_ROOTS) {
    try { files.push(...await walkFiles(root, directory)); }
    catch (error) { if (error.code !== 'ENOENT' || !['scripts'].includes(directory)) throw error; }
  }
  return fingerprint(root, files);
}

export async function policyFingerprint(root) {
  return fingerprint(root, [
    ...await walkFiles(root, 'release'),
    ...await walkFiles(root, 'evaluation/fixtures'),
    ...await walkFiles(root, 'evaluation/stress-fixtures'),
    'evaluation/heldout-v1.json', 'evaluation/screenshot-specs-v1.json',
    'evaluation/stress-v2.json', 'evaluation/stress-screenshot-specs-v1.json',
    'evaluation/invalid-input-v1.json',
    'verification/evaluation-completion-2026-09-27/reference-plan.json',
  ]);
}

export async function expectedTestFiles(root) {
  return [...await walkFiles(root, 'tests'), ...await walkFiles(root, 'src')]
    .filter((file) => file.endsWith('.test.ts')).sort();
}

// Inspect names only. Secret files are never read, hashed, or copied into a receipt.
export async function validateBuildEnvironment(root, env = process.env) {
  const names = await readdir(root);
  // Windows treats these names case-insensitively. Apply the same boundary on
  // every platform so moving a release checkout cannot enable an override.
  const issues = names.filter((name) => ['.env', '.env.local', '.env.production', '.env.production.local'].includes(name.toLowerCase()))
    .map((name) => `Untracked build environment file: ${name}`);
  const forbidden = /^(VITE_|VITEST|WRANGLER_|CLOUDFLARE_ENV$|CLOUDFLARE_ACCOUNT_ID$|CF_ACCOUNT_ID$|CLOUDFLARE_API_BASE_URL$|CF_API_BASE_URL$|NODE_OPTIONS$|NODE_PATH$)/i;
  for (const name of Object.keys(env)) if (forbidden.test(name) && env[name]) issues.push(`Unsupported release environment override: ${name}`);
  return issues;
}
