import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Native Node ESM release utilities are exercised directly.
import { sourceFingerprint, SOURCE_ROOTS, SOURCE_FILES, validateBuildEnvironment } from '../release/files.mjs';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'skeptiscan-release-files-'));
  for (const folder of SOURCE_ROOTS) await mkdir(path.join(directory, folder));
  for (const file of SOURCE_FILES) await writeFile(path.join(directory, file), '{}');
  await writeFile(path.join(directory, 'server/model.ts'), 'pinned model and prompt');
});

describe('release environment boundary', () => {
  it.each([
    'CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL',
    'cloudflare_api_base_url', 'Cf_Api_Base_Url',
    'cloudflare_env', 'Wrangler_Config', 'node_options', 'Node_Path',
    'vite_private_setting', 'vitest_segFault_retry',
    'cloudflare_account_id', 'cf_account_id',
  ])('rejects %s without disclosing its value', async (name) => {
    const issues = await validateBuildEnvironment(directory, { [name]: 'SYNTHETIC_PRIVATE_OVERRIDE' });
    expect(issues).toEqual([`Unsupported release environment override: ${name}`]);
    expect(JSON.stringify(issues)).not.toContain('SYNTHETIC_PRIVATE_OVERRIDE');
  });

  it.each(['.ENV', '.Env.Local', '.ENV.PRODUCTION', '.Env.Production.Local'])(
    'rejects case variants of build environment file %s', async (name) => {
      await writeFile(path.join(directory, name), 'SYNTHETIC_PRIVATE_FILE_CONTENT');
      const issues = await validateBuildEnvironment(directory, {});
      expect(issues).toEqual([`Untracked build environment file: ${name}`]);
      expect(JSON.stringify(issues)).not.toContain('SYNTHETIC_PRIVATE_FILE_CONTENT');
    },
  );

  it('preserves supported authentication environment names and ordinary execution settings', async () => {
    expect(await validateBuildEnvironment(directory, {
      CLOUDFLARE_API_TOKEN: 'SYNTHETIC_TOKEN',
      CLOUDFLARE_API_KEY: 'SYNTHETIC_KEY',
      CLOUDFLARE_EMAIL: 'operator@example.invalid',
      CF_API_TOKEN: 'SYNTHETIC_LEGACY_TOKEN',
      CF_API_KEY: 'SYNTHETIC_LEGACY_KEY',
      CF_EMAIL: 'operator@example.invalid',
      cloudflare_api_token: 'SYNTHETIC_WINDOWS_TOKEN',
      PATH: 'synthetic-path', CI: 'true', NODE_ENV: 'production',
    })).toEqual([]);
  });
});
afterEach(async () => {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('skeptiscan-release-files-')) throw new Error('Unsafe test cleanup path');
  await rm(target, { recursive: true, force: true });
});
describe('release source fingerprint', () => {
  it('changes when a pinned model, prompt, configuration or test changes', async () => {
    let current = (await sourceFingerprint(directory)).hash;
    for (const file of ['server/model.ts', 'wrangler.jsonc', 'tests/new-safeguard.test.ts', 'public/_headers', 'release/policy.json']) {
      await writeFile(path.join(directory, file), 'changed');
      const next = (await sourceFingerprint(directory)).hash;
      expect(next).not.toBe(current);
      current = next;
    }
  });
  it('hashes filenames as well as bytes', async () => {
    const before = (await sourceFingerprint(directory)).hash;
    await rename(path.join(directory, 'server/model.ts'), path.join(directory, 'server/other-model.ts'));
    expect((await sourceFingerprint(directory)).hash).not.toBe(before);
  });
  it('excludes secrets, local databases, receipts and collected evaluation outputs', async () => {
    const before = await sourceFingerprint(directory);
    await writeFile(path.join(directory, '.dev.vars'), 'SYNTHETIC_PLACEHOLDER=never-a-key');
    for (const folder of ['.wrangler', '.release-gate', 'evaluation']) await mkdir(path.join(directory, folder));
    await writeFile(path.join(directory, '.wrangler/local.sqlite'), 'fake database');
    await writeFile(path.join(directory, '.release-gate/latest.json'), 'fake receipt');
    await writeFile(path.join(directory, 'evaluation/release-evidence.json'), 'fake evidence');
    expect(await sourceFingerprint(directory)).toEqual(before);
  });
  it('fails when a required source directory or configuration file disappears', async () => {
    await rename(path.join(directory, 'wrangler.jsonc'), path.join(directory, 'ignored-config.jsonc'));
    await expect(sourceFingerprint(directory)).rejects.toThrow();
  });
  it('rejects a Vite production environment file by name without reading its content', async () => {
    await writeFile(path.join(directory, '.env.production'), 'SYNTHETIC_PRIVATE_VALUE');
    const issues = await validateBuildEnvironment(directory, {});
    expect(issues).toEqual(['Untracked build environment file: .env.production']);
    expect(JSON.stringify(issues)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
  });
});
