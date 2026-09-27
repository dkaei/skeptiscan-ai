import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Native Node ESM release utilities are tested directly.
import { runReleaseGate } from '../release/gate.mjs';
// @ts-expect-error Native Node ESM release utilities are tested directly.
import { STAGING_TARGET, ACCESS_RECEIPT_MAX_AGE_MS, validatePrivateAccessReceipt, verifyPrivateAccess, privateAccessReceiptHash, candidateUploadArgs, uploadedVersionId } from '../release/staging.mjs';
// @ts-expect-error Native Node ESM release utilities are tested directly.
import { sha256 } from '../release/files.mjs';

const now = Date.parse('2026-09-27T10:00:00Z');
const hashes = { candidateHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) };
const versionId = 'ca5eef4b-e6ce-4604-a26d-6ad2b19b38d3';
const receipt = () => ({ schemaVersion: 1, purpose: 'private_candidate_upload', verifiedAt: new Date(now).toISOString(),
  ...hashes, ...STAGING_TARGET, productionVersionId: versionId, accessDestinationType: 'worker',
  accessProtectsAllWorkerVersions: true, workerBindingsVerified: true, versionUrlsEnabled: false,
  verifiedBy: 'read_only_dashboard_and_network', verificationArtifacts: [{ path: 'verification/access.json', sha256: sha256('{}') }] });
const config = () => ({ name: STAGING_TARGET.workerName, account_id: STAGING_TARGET.accountId, workers_dev: true, preview_urls: false,
  d1_databases: [{ binding: 'DB', database_id: STAGING_TARGET.d1DatabaseId, preview_database_id: '00000000-0000-0000-0000-000000000000' }],
  vars: { ENVIRONMENT: 'production', ACCESS_AUD: STAGING_TARGET.accessAud, ACCESS_TEAM_DOMAIN: STAGING_TARGET.accessTeamDomain,
    ALLOWED_EMAILS: STAGING_TARGET.operatorEmail, BUDGET_LIMIT_MICRO_USD: '7000000' } });
const validate = (value: unknown, configuration = config(), time = now) => validatePrivateAccessReceipt({ receipt: value, ...hashes, config: configuration, now: time });

describe('private candidate Access receipt', () => {
  it('accepts the exact pilot configuration without enabling Version URLs', () => expect(validate(receipt()).passed).toBe(true));
  it.each([null, {}, [], { ...receipt(), force: true }])('rejects absent, malformed or extra authority fields', value => expect(validate(value).passed).toBe(false));
  it.each(['candidateHash', 'policyHash', 'workerName', 'accountId', 'd1DatabaseId', 'accessApplicationId', 'accessAud', 'accessTeamDomain', 'operatorEmail', 'versionHostnamePattern', 'accessDestinationType'])('rejects altered %s', key => {
    expect(validate({ ...receipt(), [key]: 'another-target' }).passed).toBe(false);
  });
  it.each(['accessProtectsAllWorkerVersions', 'workerBindingsVerified'])('requires %s', key => expect(validate({ ...receipt(), [key]: false }).passed).toBe(false));
  it('does not accept enabled routing or a production-only Access destination', () => {
    expect(validate({ ...receipt(), versionUrlsEnabled: true }).passed).toBe(false);
    expect(validate({ ...receipt(), accessDestinationType: 'hostname' }).passed).toBe(false);
  });
  it.each([-1, ACCESS_RECEIPT_MAX_AGE_MS + 1, Number.NaN])('rejects a future, stale or invalid verification clock %s', age => {
    expect(validate(receipt(), config(), now + age).passed).toBe(false);
  });
  it('accepts the one-hour boundary, never a receipt for another candidate', () => {
    expect(validate(receipt(), config(), now + ACCESS_RECEIPT_MAX_AGE_MS).passed).toBe(true);
    expect(validate({ ...receipt(), candidateHash: 'c'.repeat(64) }).passed).toBe(false);
  });
  it.each(['../outside.json', 'verification/../outside.json', 'verification//a.json', 'verification/a%2fb.json', 'verification/a\\b.json', 'https://example.test/a'])('rejects unsafe artifact path %s', artifactPath => {
    expect(validate({ ...receipt(), verificationArtifacts: [{ path: artifactPath, sha256: 'a'.repeat(64) }] }).passed).toBe(false);
  });
  it('requires at least one distinct verification artifact', () => {
    expect(validate({ ...receipt(), verificationArtifacts: [] }).passed).toBe(false);
    const value = receipt(); value.verificationArtifacts.push(value.verificationArtifacts[0]);
    expect(validate(value).passed).toBe(false);
  });
  it.each(['name', 'account_id', 'workers_dev', 'preview_urls'])('rejects config drift in %s', key => {
    expect(validate(receipt(), { ...config(), [key]: 'changed' }).passed).toBe(false);
  });
  it.each(['ENVIRONMENT', 'ACCESS_AUD', 'ACCESS_TEAM_DOMAIN', 'ALLOWED_EMAILS', 'BUDGET_LIMIT_MICRO_USD'])('rejects identity or budget changes in %s', key => {
    const value = config(); value.vars = { ...value.vars, [key]: 'changed' };
    expect(validate(receipt(), value).passed).toBe(false);
  });
  it('rejects a different ledger or a local preview database', () => {
    const value = config(); value.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000001';
    expect(validate(receipt(), value).passed).toBe(false);
    value.d1_databases.push(config().d1_databases[0]);
    expect(validate(receipt(), value).passed).toBe(false);
  });
  it('never reflects malformed receipt contents in the failure report', () => {
    expect(JSON.stringify(validate({ ...receipt(), accessAud: 'private-value' }))).not.toContain('private-value');
  });
});

const temporaryRoots: string[] = [];
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'skeptiscan-staging-')); temporaryRoots.push(root);
  await mkdir(path.join(root, '.release-gate'));
  await mkdir(path.join(root, 'verification'));
  await writeFile(path.join(root, 'verification/access.json'), '{}');
  await writeFile(path.join(root, '.release-gate/private-access.json'), JSON.stringify(receipt()));
  await writeFile(path.join(root, 'wrangler.jsonc'), '// Explicit JSONC config, no secret files.\n' + JSON.stringify(config()));
  return root;
}
describe('bounded receipt and evidence files', () => {
  it('uses actual pinned Wrangler JSONC parsing and hashes real attestation artifacts offline', async () => {
    const root = await fixture();
    const result = await verifyPrivateAccess({ root, ...hashes, now });
    expect(result.passed).toBe(true);
    expect(result.receiptHash).toBe(await privateAccessReceiptHash(root));
  });
  it('rejects changed artifacts', async () => {
    const root = await fixture(); await writeFile(path.join(root, 'verification/access.json'), '{"changed":true}');
    expect((await verifyPrivateAccess({ root, ...hashes, now })).passed).toBe(false);
  });
  it('rejects oversized or missing receipts without reading credentials', async () => {
    const root = await fixture(); await writeFile(path.join(root, '.release-gate/private-access.json'), 'x'.repeat(16_385));
    expect((await verifyPrivateAccess({ root, ...hashes, now })).passed).toBe(false);
    await rm(path.join(root, '.release-gate/private-access.json'));
    expect(await privateAccessReceiptHash(root)).toBeNull();
  });
  it('rejects a symlinked artifact ancestor even if the bytes match', async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'skeptiscan-staging-outside-')); temporaryRoots.push(outside);
    await writeFile(path.join(outside, 'access.json'), '{}');
    await rm(path.join(root, 'verification'), { recursive: true });
    await symlink(outside, path.join(root, 'verification'), 'junction');
    expect((await verifyPrivateAccess({ root, ...hashes, now })).passed).toBe(false);
  });
});

function steps() {
  return { snapshot: vi.fn(async () => ({ ...hashes, privateAccessHash: 'c'.repeat(64) })),
    environment: vi.fn(async () => ({ passed: true })), privateAccess: vi.fn(async () => ({ passed: true })),
    safeguards: vi.fn(async () => ({ passed: true })), build: vi.fn(async () => ({ passed: true })),
    package: vi.fn(async () => ({ passed: true })), integrity: vi.fn(async () => ({ passed: true })),
    evaluation: vi.fn(async () => ({ passed: false })), writeReport: vi.fn(async () => {}),
    uploadCandidate: vi.fn(async () => ({ exitCode: 0 as number | null, versionId: versionId as string | null })),
    deploy: vi.fn(async () => ({ exitCode: 0 })) };
}
describe('candidate lane versus production gate', () => {
  it('uploads once after fresh safeguards and final verification without requiring live evidence or deploying', async () => {
    const s = steps(); const report = await runReleaseGate({ mode: 'stage', steps: s });
    expect(report).toMatchObject({ passed: true, deploymentAttempted: false, candidateUploadAttempted: true, candidateUploaded: true, candidateVersionId: versionId, versionUrlsEnabled: false });
    expect(s.uploadCandidate).toHaveBeenCalledOnce(); expect(s.deploy).not.toHaveBeenCalled(); expect(s.evaluation).not.toHaveBeenCalled();
    expect(s.privateAccess).toHaveBeenCalledTimes(2); expect(s.integrity).toHaveBeenCalledTimes(2);
    expect(s.uploadCandidate.mock.invocationCallOrder[0]).toBeGreaterThan(s.writeReport.mock.invocationCallOrder[0]);
  });
  it.each(['environment', 'privateAccess', 'safeguards', 'build', 'package', 'integrity'] as const)('blocks staging when %s fails', async name => {
    const s = steps(); s[name].mockResolvedValue({ passed: false });
    expect((await runReleaseGate({ mode: 'stage', steps: s })).passed).toBe(false);
    expect(s.uploadCandidate).not.toHaveBeenCalled(); expect(s.deploy).not.toHaveBeenCalled();
  });
  it('blocks if receipt expires between verification and upload', async () => {
    const s = steps(); s.privateAccess.mockResolvedValueOnce({ passed: true }).mockResolvedValue({ passed: false });
    expect((await runReleaseGate({ mode: 'stage', steps: s })).passed).toBe(false); expect(s.uploadCandidate).not.toHaveBeenCalled();
  });
  it('blocks changed receipt bytes after the report is written', async () => {
    const s = steps(); s.snapshot.mockResolvedValueOnce({ ...hashes, privateAccessHash: 'c'.repeat(64) })
      .mockResolvedValueOnce({ ...hashes, privateAccessHash: 'c'.repeat(64) }).mockResolvedValue({ ...hashes, privateAccessHash: 'd'.repeat(64) });
    expect((await runReleaseGate({ mode: 'stage', steps: s })).passed).toBe(false); expect(s.uploadCandidate).not.toHaveBeenCalled();
  });
  it('does not upload if writing the initial report fails', async () => {
    const s = steps(); s.writeReport.mockRejectedValueOnce(new Error('disk full'));
    expect((await runReleaseGate({ mode: 'stage', steps: s })).passed).toBe(false); expect(s.uploadCandidate).not.toHaveBeenCalled();
  });
  it.each([null, 1])('never retries an unsuccessful or unknown upload (%s)', async exitCode => {
    const s = steps(); s.uploadCandidate.mockResolvedValue({ exitCode, versionId: null });
    const report = await runReleaseGate({ mode: 'stage', steps: s });
    expect(report).toMatchObject({ passed: false, candidateUploadAttempted: true, candidateUploaded: false, deploymentAttempted: false });
    expect(s.uploadCandidate).toHaveBeenCalledOnce(); expect(s.deploy).not.toHaveBeenCalled();
  });
  it('requires a confirmed immutable version ID even with exit zero', async () => {
    const s = steps(); s.uploadCandidate.mockResolvedValue({ exitCode: 0, versionId: null });
    expect((await runReleaseGate({ mode: 'stage', steps: s })).passed).toBe(false);
  });
  it.each(['check', 'deploy'])('cannot substitute a passing staging receipt for live evidence in %s', async mode => {
    const s = steps(); const report = await runReleaseGate({ mode, steps: s });
    expect(report.passed).toBe(false); expect(s.evaluation).toHaveBeenCalledOnce();
    expect(s.deploy).not.toHaveBeenCalled(); expect(s.uploadCandidate).not.toHaveBeenCalled();
  });
  it('uses only the same-worker version-upload command and fixed config/assets', () => {
    const root = process.cwd(); const bundlePath = path.join(root, '.release-gate/runs/example/worker/index.js');
    expect(candidateUploadArgs({ root, bundlePath })).toEqual(['versions', 'upload', bundlePath, '--config', path.join(root, 'wrangler.jsonc'), '--no-bundle', '--assets', path.join(root, 'dist'), '--strict']);
  });
  it('does not add argument forwarding, preview enabling or secret upload to the CLI', async () => {
    const script = await readFile(path.join(process.cwd(), 'scripts/release.mjs'), 'utf8');
    expect(script).toContain('process.argv.length !== 3');
    expect(script).not.toContain('--preview-alias'); expect(script).not.toContain('--secrets-file');
  });
  it('accepts only one bounded exact Wrangler version acknowledgement', () => {
    expect(uploadedVersionId(`Uploaded skeptiscan-pilot\nWorker Version ID: ${versionId}\n`)).toBe(versionId);
    expect(uploadedVersionId(`Provider error mentions Worker Version ID: ${versionId}`)).toBeNull();
    expect(uploadedVersionId(`Worker Version ID: ${versionId}\nWorker Version ID: ${versionId}\n`)).toBeNull();
    expect(uploadedVersionId('x'.repeat(1_000_001))).toBeNull();
  });
});
