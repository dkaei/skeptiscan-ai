import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
// @ts-expect-error The release CLI uses native Node ESM, separately exercised here.
import { runReleaseGate } from '../release/gate.mjs';
// @ts-expect-error The release CLI uses native Node ESM, separately exercised here.
import { evaluateSafeguards } from '../release/safeguards.mjs';
// @ts-expect-error The release CLI uses native Node ESM, separately exercised here.
import { validateBuildEnvironment } from '../release/files.mjs';

const root = process.cwd();
const snapshot = { candidateHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), evidenceHash: 'c'.repeat(64) };
function steps() {
  return {
    snapshot: vi.fn(async () => ({ ...snapshot })),
    environment: vi.fn(async () => ({ passed: true, issues: [] as string[] })),
    safeguards: vi.fn(async () => ({ passed: true, issues: [] as string[] })),
    build: vi.fn(async () => ({ passed: true, issues: [] as string[] })),
    package: vi.fn(async () => ({ passed: true, issues: [] as string[] })),
    evaluation: vi.fn(async () => ({ passed: true, issues: [] as string[] })),
    integrity: vi.fn(async () => ({ passed: true, issues: [] as string[] })),
    writeReport: vi.fn(async () => {}),
    deploy: vi.fn(async () => ({ exitCode: 0 as number | null })),
  };
}

describe('deployment interlock', () => {
  it('never uploads in check mode even when every requirement passes', async () => {
    const s = steps();
    expect((await runReleaseGate({ mode: 'check', steps: s })).passed).toBe(true);
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it('dispatches exactly once only after fresh checks and final integrity checks', async () => {
    const s = steps();
    const report = await runReleaseGate({ mode: 'deploy', steps: s });
    expect(report.passed).toBe(true);
    expect(s.deploy).toHaveBeenCalledOnce();
    expect(s.snapshot).toHaveBeenCalledTimes(3);
    expect(s.integrity).toHaveBeenCalledTimes(2);
    expect(s.deploy.mock.invocationCallOrder[0]).toBeGreaterThan(s.writeReport.mock.invocationCallOrder[0]);
  });
  it.each(['environment', 'safeguards', 'build', 'package', 'evaluation', 'integrity'] as const)('blocks deployment when %s fails', async (name) => {
    const s = steps();
    s[name].mockResolvedValue({ passed: false, issues: [`${name} failed`] });
    const report = await runReleaseGate({ mode: 'deploy', steps: s });
    expect(report.passed).toBe(false);
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it.each(['environment', 'safeguards', 'build', 'package', 'evaluation', 'integrity'] as const)('blocks deployment when %s throws', async (name) => {
    const s = steps();
    s[name].mockRejectedValue(new Error('private response body'));
    const report = await runReleaseGate({ mode: 'deploy', steps: s });
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('private response body');
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it.each(['candidateHash', 'policyHash', 'evidenceHash'] as const)('rejects changed %s during verification', async (key) => {
    const s = steps();
    s.snapshot.mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, [key]: 'd'.repeat(64) });
    expect((await runReleaseGate({ mode: 'deploy', steps: s })).passed).toBe(false);
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it('rejects edits after the passing receipt is written', async () => {
    const s = steps();
    s.snapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, candidateHash: 'changed' });
    expect((await runReleaseGate({ mode: 'deploy', steps: s })).passed).toBe(false);
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it('rejects asset edits immediately before dispatch', async () => {
    const s = steps();
    s.integrity.mockResolvedValueOnce({ passed: true, issues: [] }).mockResolvedValue({ passed: false, issues: ['changed'] });
    expect((await runReleaseGate({ mode: 'deploy', steps: s })).passed).toBe(false);
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it('blocks an unexplained integrity failure even in check mode', async () => {
    const s = steps();
    s.integrity.mockResolvedValue({ passed: false, issues: [] });
    const report = await runReleaseGate({ mode: 'check', steps: s });
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('Build integrity was not verified.');
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it('cannot treat an unreadable receipt as release authorization', async () => {
    const s = steps();
    s.writeReport.mockRejectedValueOnce(new Error('disk full'));
    expect((await runReleaseGate({ mode: 'deploy', steps: s })).passed).toBe(false);
    expect(s.deploy).not.toHaveBeenCalled();
  });
  it('records failed deployment without retrying', async () => {
    const s = steps();
    s.deploy.mockResolvedValue({ exitCode: 1 });
    const report = await runReleaseGate({ mode: 'deploy', steps: s });
    expect(report.passed).toBe(false);
    expect(report.deploymentAttempted).toBe(true);
    expect(s.deploy).toHaveBeenCalledOnce();
  });
  it('does not accept a force mode', async () => {
    const s = steps();
    await expect(runReleaseGate({ mode: 'force', steps: s })).rejects.toThrow();
    expect(s.deploy).not.toHaveBeenCalled();
  });
});

function passingSafeguards() {
  return { numTotalTests: 1, numPassedTests: 1, numTotalTestSuites: 2, numPassedTestSuites: 2,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
    success: true, startTime: 10000, testResults: [{ name: path.join(root, 'tests/security.test.ts'), status: 'passed',
      assertionResults: [{ fullName: 'protects secrets', status: 'passed', failureMessages: [] }] }] };
}
function grade(report: unknown, exitCode: number | null = 0) {
  return evaluateSafeguards({ report, exitCode, startedAt: 10000, finishedAt: 11000, root,
    expectedFiles: ['tests/security.test.ts'], minimumTests: 1 });
}
describe('safeguard report verification', () => {
  it('accepts nested-suite totals independently of file counts', () => expect(grade(passingSafeguards()).passed).toBe(true));
  it.each([null, {}, [], 'passed'])('rejects a missing or malformed report %s', (report) => expect(grade(report).passed).toBe(false));
  it.each([1, null])('requires successful process exit %s', (code) => expect(grade(passingSafeguards(), code).passed).toBe(false));
  it.each(['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites'])('rejects nonzero %s', (key) => {
    expect(grade({ ...passingSafeguards(), [key]: 1 }).passed).toBe(false);
  });
  it.each([0, 999, 12000])('rejects stale or future time %s', (startTime) => expect(grade({ ...passingSafeguards(), startTime }).passed).toBe(false));
  it('rejects misleading passing totals when an individual test failed', () => {
    const report = passingSafeguards(); report.testResults[0].assertionResults[0].status = 'failed';
    expect(grade(report).passed).toBe(false);
  });
  it('rejects omitted test files', () => expect(grade({ ...passingSafeguards(), testResults: [] }).passed).toBe(false));
  it('rejects duplicate file reports', () => {
    const report = passingSafeguards(); report.testResults.push(report.testResults[0]);
    expect(grade(report).passed).toBe(false);
  });
  it('rejects empty files and inflated totals', () => {
    const report = passingSafeguards(); report.testResults[0].assertionResults = [];
    expect(grade(report).passed).toBe(false);
  });
  it('rejects unhandled runner errors even if assertions pass', () => expect(grade({ ...passingSafeguards(), unhandledErrors: ['crash'] }).passed).toBe(false));
  it('rejects snapshot updates during release', () => expect(grade({ ...passingSafeguards(), snapshot: { didUpdate: true } }).passed).toBe(false));
  it('rejects shrinking the baseline test count', () => {
    expect(evaluateSafeguards({ report: passingSafeguards(), exitCode: 0, startedAt: 10000, finishedAt: 11000,
      root, expectedFiles: ['tests/security.test.ts'] }).passed).toBe(false);
  });
  it('rejects removing a required test even if replacement tests preserve the count', () => {
    expect(evaluateSafeguards({ report: passingSafeguards(), exitCode: 0, startedAt: 10000, finishedAt: 11000,
      root, expectedFiles: ['tests/security.test.ts'], minimumTests: 1,
      requiredTests: [{ file: 'tests/security.test.ts', names: ['protects secrets', 'required accounting guard'] }] }).passed).toBe(false);
  });
});

describe('build environment guard', () => {
  it.each(['VITE_BYPASS', 'VITEST_SEGFAULT_RETRY', 'WRANGLER_ENV', 'CLOUDFLARE_ENV', 'CLOUDFLARE_ACCOUNT_ID', 'NODE_OPTIONS', 'NODE_PATH'])('rejects %s without exposing its value', async (name) => {
    const issues = await validateBuildEnvironment(root, { [name]: 'private-value' });
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain('private-value');
  });
  it('permits authentication credentials without reading or reporting their values', async () => {
    expect(await validateBuildEnvironment(root, { CLOUDFLARE_API_TOKEN: 'private-value', PATH: 'example' })).toEqual([]);
  });
});
