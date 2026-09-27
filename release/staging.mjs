import { z } from 'zod';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './files.mjs';

// This lane is deliberately restricted to the existing pilot, not a generic
// environment provisioner. Changing these boundaries requires source review.
export const STAGING_TARGET = Object.freeze({
  workerName: 'skeptiscan-pilot',
  accountId: '11111111111111111111111111111111',
  d1DatabaseId: '11111111-1111-4111-8111-111111111111',
  accessApplicationId: '22222222-2222-4222-8222-222222222222',
  accessAud: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  accessTeamDomain: 'your-team.cloudflareaccess.com',
  operatorEmail: 'operator@example.invalid',
  versionHostnamePattern: '*-skeptiscan-pilot.example.invalid',
});
export const PRIVATE_ACCESS_RECEIPT = '.release-gate/private-access.json';
export const ACCESS_RECEIPT_MAX_AGE_MS = 60 * 60 * 1000;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Artifact = z.object({
  path: z.string().max(500).regex(/^verification\/[A-Za-z0-9_./-]+$/).refine(value =>
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
  sha256: Hash,
}).strict();
const Receipt = z.object({
  schemaVersion: z.literal(1),
  purpose: z.literal('private_candidate_upload'),
  verifiedAt: z.iso.datetime(),
  candidateHash: Hash,
  policyHash: Hash,
  ...Object.fromEntries(Object.entries(STAGING_TARGET).map(([key, value]) => [key, z.literal(value)])),
  productionVersionId: z.uuid(),
  accessDestinationType: z.literal('worker'),
  accessProtectsAllWorkerVersions: z.literal(true),
  workerBindingsVerified: z.literal(true),
  versionUrlsEnabled: z.literal(false),
  verifiedBy: z.literal('read_only_dashboard_and_network'),
  verificationArtifacts: z.array(Artifact).min(1).max(10),
}).strict();

export function validatePrivateAccessReceipt({ receipt, candidateHash, policyHash, config, now = Date.now() }) {
  const parsed = Receipt.safeParse(receipt);
  if (!parsed.success) return { passed: false, issues: ['Private Access receipt is missing or malformed.'] };
  const value = parsed.data;
  const issues = [];
  const verifiedAt = Date.parse(value.verifiedAt);
  if (!Number.isFinite(now) || verifiedAt > now || now - verifiedAt > ACCESS_RECEIPT_MAX_AGE_MS) issues.push('Private Access verification is stale or future-dated; verify it again.');
  if (value.candidateHash !== candidateHash || value.policyHash !== policyHash) issues.push('Private Access receipt does not identify this frozen candidate and policy.');
  const db = config?.d1_databases;
  if (config?.name !== STAGING_TARGET.workerName || config?.account_id !== STAGING_TARGET.accountId
    || config?.workers_dev !== true || config?.preview_urls !== false
    || !Array.isArray(db) || db.length !== 1 || db[0]?.binding !== 'DB' || db[0]?.database_id !== STAGING_TARGET.d1DatabaseId
    || db[0]?.preview_database_id !== '00000000-0000-0000-0000-000000000000'
    || config?.vars?.ENVIRONMENT !== 'production' || config?.vars?.ACCESS_AUD !== STAGING_TARGET.accessAud
    || config?.vars?.ACCESS_TEAM_DOMAIN !== STAGING_TARGET.accessTeamDomain || config?.vars?.ALLOWED_EMAILS !== STAGING_TARGET.operatorEmail
    || config?.vars?.BUDGET_LIMIT_MICRO_USD !== '7000000') {
    issues.push('Staging configuration must preserve the existing Worker, private identity, shared ledger, budget and disabled Version URLs.');
  }
  if (new Set(value.verificationArtifacts.map(item => item.path)).size !== value.verificationArtifacts.length) issues.push('Private Access verification artifacts contain duplicates.');
  return { passed: issues.length === 0, issues, verifiedAt: value.verifiedAt, productionVersionId: value.productionVersionId };
}

// Bound every file and reject symlinks at each ancestor before reading. Receipt
// contents are operator attestations, never credentials or remote proof.
async function safeBytes(root, relative, maxBytes) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symlink rejected.');
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error('Invalid verification file.');
  return readFile(current);
}

export async function privateAccessReceiptHash(root) {
  try { return sha256(await safeBytes(root, PRIVATE_ACCESS_RECEIPT, 16_384)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function verifyPrivateAccess({ root, candidateHash, policyHash, now = Date.now() }) {
  try {
    const bytes = await safeBytes(root, PRIVATE_ACCESS_RECEIPT, 16_384);
    const receipt = JSON.parse(bytes.toString('utf8'));
    // Use the installed, pinned Wrangler's own JSONC parser. This reads only
    // the explicitly named config; no secrets files or inferred environments.
    const { experimental_readRawConfig } = await import('wrangler');
    const configPath = path.join(root, 'wrangler.jsonc');
    await safeBytes(root, 'wrangler.jsonc', 100_000);
    const resolved = experimental_readRawConfig({ config: configPath }, { redirect: false });
    if (path.resolve(resolved.configPath) !== configPath || resolved.redirected) throw new Error('Configuration redirect rejected.');
    const check = validatePrivateAccessReceipt({ receipt, candidateHash, policyHash, config: resolved.rawConfig, now });
    if (!check.passed) return check;
    for (const artifact of receipt.verificationArtifacts) {
      if (sha256(await safeBytes(root, artifact.path, 10_000_000)) !== artifact.sha256) return { passed: false, issues: ['Private Access verification artifact changed.'] };
    }
    return { ...check, receiptHash: sha256(bytes), note: 'Locally verified configuration attestation; not cryptographic proof of remote policy.' };
  } catch {
    return { passed: false, issues: ['Private Access receipt, configuration or verification artifacts could not be verified.'] };
  }
}

export function candidateUploadArgs({ root, bundlePath }) {
  // No alternate Worker, account, environment, vars, secrets, alias, triggers,
  // routing or production deployment command is accepted by this lane.
  return ['versions', 'upload', bundlePath, '--config', path.join(root, 'wrangler.jsonc'),
    '--no-bundle', '--assets', path.join(root, 'dist'), '--strict'];
}

export function uploadedVersionId(output) {
  if (typeof output !== 'string' || output.length > 1_000_000) return null;
  const matches = [...output.matchAll(/^Worker Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s*$/gm)];
  return matches.length === 1 ? matches[0][1] : null;
}
