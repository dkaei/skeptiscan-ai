import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, open, readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sourceFingerprint, policyFingerprint, expectedTestFiles, fingerprint, walkFiles, sha256, validateBuildEnvironment } from '../release/files.mjs';
import { evaluateSafeguards } from '../release/safeguards.mjs';
import { evaluateLiveEvidence } from '../release/evaluation.mjs';
import { validateArtifacts } from '../release/artifacts.mjs';
import { loadManifest } from '../release/manifest.mjs';
import { runReleaseGate } from '../release/gate.mjs';
import { privateAccessReceiptHash, verifyPrivateAccess, candidateUploadArgs, uploadedVersionId } from '../release/staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['prepare', 'stage', 'check', 'deploy'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/release.mjs prepare|stage|check|deploy. Overrides and bypass flags are not supported.');
  process.exit(2);
}

const stateRoot = path.join(root, '.release-gate');
const evidencePath = path.join(root, 'evaluation/release-evidence.json');
const env = { ...process.env, CI: 'true', NODE_ENV: 'production', NO_COLOR: '1' };
delete env.FORCE_COLOR;
const binaries = { test: 'node_modules/vitest/vitest.mjs', tsc: 'node_modules/typescript/bin/tsc', vite: 'node_modules/vite/bin/vite.js', wrangler: 'node_modules/wrangler/bin/wrangler.js' };

async function safeDirectory(directory) {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output directory is outside the project.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Output directory is a symlink.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true });
}

async function snapshot() {
  const source = await sourceFingerprint(root);
  const policy = await policyFingerprint(root);
  let evidenceHash = null;
  try {
    const stat = await lstat(evidencePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Invalid evidence file.');
    evidenceHash = sha256(await readFile(evidencePath));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { candidateHash: source.hash, policyHash: policy.hash, evidenceHash,
    ...(mode === 'stage' ? { privateAccessHash: await privateAccessReceiptHash(root) } : {}) };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

await safeDirectory(stateRoot);
let lock;
let retainLock = false;
try { lock = await open(path.join(stateRoot, 'active.lock'), 'wx'); }
catch { console.error('Release gate is already running, or its lock needs inspection. No deployment attempted.'); process.exit(1); }

try {
  const manifest = await loadManifest(root);
  if (mode === 'prepare') {
    const current = await snapshot();
    const candidate = {
      schemaVersion: 1, ...current, preparedAt: new Date().toISOString(),
      note: 'Preparation only. No cases have been executed or reviewed. Never label mocks as live evidence.',
      manifest,
      evidenceTemplate: {
        schemaVersion: 1, candidateHash: current.candidateHash, policyHash: current.policyHash,
        origin: 'live', startedAt: null, completedAt: null, reviewer: null,
        cases: manifest.cases.map(({ id, cohort, route }) => ({ id, cohort, route, outcome: 'not_attempted', firstAttempt: true,
          attempts: [], artifact: null, semanticReview: null, reviewed: false, workflowMatch: null, criticalFindings: null })),
      },
    };
    await writeFile(path.join(stateRoot, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
    console.log(`Prepared ${manifest.cases.length} pending cases in .release-gate/candidate.json. This is not release approval.`);
  } else {
    const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
    const runDirectory = path.join(stateRoot, 'runs', runId);
    await safeDirectory(runDirectory);
    let outputSnapshot = null;
    let evaluationDigest = null;
    let environmentOkay = false;
    let buildOkay = false;
    async function command(name, binary, args) {
      if (retainLock) return { exitCode: null };
      const fd = openSync(path.join(runDirectory, `${name}.log`), 'wx');
      console.log(`Checking ${name}...`);
      return new Promise((resolve) => {
        let child;
        let settled = false;
        let timer;
        const finish = (exitCode) => { if (settled) return; settled = true; clearTimeout(timer); closeSync(fd); resolve({ exitCode }); };
        try {
          child = spawn(process.execPath, [path.join(root, binary), ...args], { cwd: root, env: { ...env, NODE_ENV: name === 'safeguards' ? 'test' : 'production' }, shell: false, windowsHide: true, stdio: ['ignore', fd, fd] });
          timer = setTimeout(() => {
            // A wrapper can have grandchildren. Never assume killing its parent
            // proves the process tree stopped, and never authorize a second run.
            retainLock = true;
            child.kill();
            finish(null);
          }, 300_000);
          child.once('error', () => finish(null));
          child.once('close', finish);
        } catch { finish(null); }
      });
    }
    async function outputs() {
      return fingerprint(root, [...await walkFiles(root, 'dist'), ...await walkFiles(root, path.relative(root, path.join(runDirectory, 'worker')))]);
    }
    const wranglerConfig = ['--config', path.join(root, 'wrangler.jsonc'), '--autoconfig=false'];
    const steps = {
      snapshot,
      environment: async () => {
        const issues = await validateBuildEnvironment(root);
        environmentOkay = issues.length === 0;
        return { passed: environmentOkay, issues };
      },
      privateAccess: async (initial) => verifyPrivateAccess({ root, candidateHash: initial.candidateHash, policyHash: initial.policyHash }),
      safeguards: async () => {
        const baseline = await readJson(path.join(root, 'release/safeguard-baseline.json'));
        if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.tests) || baseline.tests.reduce((total, suite) => total + (Array.isArray(suite.names) ? suite.names.length : 0), 0) < 608) {
          return { passed: false, issues: ['Safeguard coverage baseline is missing or incomplete.'] };
        }
        const reportFile = path.join(runDirectory, 'safeguards.json');
        const startedAt = Date.now();
        const result = await command('safeguards', binaries.test, ['run', '--config', 'vitest.config.ts', '--allowOnly=false', '--passWithNoTests=false', '--reporter=json', '--outputFile', reportFile]);
        return evaluateSafeguards({ report: await readJson(reportFile), exitCode: result.exitCode, startedAt, finishedAt: Date.now(), root, expectedFiles: await expectedTestFiles(root), requiredTests: baseline.tests });
      },
      build: async () => {
        const types = await command('typecheck', binaries.tsc, ['--noEmit']);
        if (types.exitCode !== 0) return { passed: false, issues: ['Typecheck failed.'] };
        await safeDirectory(path.join(root, 'dist'));
        const built = await command('build', binaries.vite, ['build', '--mode', 'production', '--emptyOutDir']);
        buildOkay = built.exitCode === 0;
        return { passed: buildOkay, issues: buildOkay ? [] : ['Production build failed.'] };
      },
      package: async () => {
        if (!buildOkay) return { passed: false, issues: ['Packaging requires a successful fresh build.'] };
        const result = await command('package', binaries.wrangler, ['deploy', ...wranglerConfig, '--dry-run', '--outdir', path.join(runDirectory, 'worker')]);
        if (result.exitCode !== 0) return { passed: false, issues: ['Worker packaging failed.'] };
        const entry = await lstat(path.join(runDirectory, 'worker/index.js'));
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.size) return { passed: false, issues: ['Worker bundle is missing.'] };
        outputSnapshot = await outputs();
        return { passed: true, issues: [], outputHash: outputSnapshot.hash };
      },
      evaluation: async (initial) => {
        const evidence = await readJson(evidencePath);
        const grade = evaluateLiveEvidence({ evidence, candidateHash: initial.candidateHash, policyHash: initial.policyHash, manifest, now: Date.now() });
        const artifacts = evidence ? await validateArtifacts({ root, evidence, manifest, candidateHash: initial.candidateHash, policyHash: initial.policyHash }) : { passed: false, issues: ['No reviewed live evaluation evidence has been supplied.'] };
        evaluationDigest = sha256(JSON.stringify(artifacts));
        return { ...grade, passed: grade.passed && artifacts.passed, issues: [...grade.issues, ...artifacts.issues], artifacts };
      },
      integrity: async () => {
        if (!environmentOkay || !outputSnapshot) return { passed: false, issues: ['Release outputs have not been verified.'] };
        const issues = [];
        if ((await outputs()).hash !== outputSnapshot.hash) issues.push('Built assets or Worker bundle changed after packaging.');
        const evidence = mode === 'stage' ? null : await readJson(evidencePath);
        if (evidence) {
          const current = await snapshot();
          if (!evaluateLiveEvidence({ evidence, candidateHash: current.candidateHash, policyHash: current.policyHash, manifest, now: Date.now() }).passed) issues.push('Live evaluation no longer meets the release requirements.');
          const artifacts = await validateArtifacts({ root, evidence, manifest, candidateHash: current.candidateHash, policyHash: current.policyHash });
          if (!artifacts.passed || sha256(JSON.stringify(artifacts)) !== evaluationDigest) issues.push('Evaluation artifacts are invalid or changed after review.');
        }
        return { passed: issues.length === 0, issues };
      },
      writeReport: async (report) => {
        const serialized = JSON.stringify({ ...report, runId }, null, 2) + '\n';
        await writeFile(path.join(runDirectory, 'report.json'), serialized);
        await writeFile(path.join(stateRoot, 'latest.json'), serialized);
      },
      deploy: async () => command('deployment', binaries.wrangler, [
        'deploy', path.join(runDirectory, 'worker/index.js'), ...wranglerConfig,
        '--no-bundle', '--assets', path.join(root, 'dist'), '--strict',
      ]),
      uploadCandidate: async () => {
        const result = await command('candidate-upload', binaries.wrangler, candidateUploadArgs({ root, bundlePath: path.join(runDirectory, 'worker/index.js') }));
        if (result.exitCode !== 0) return result;
        const logPath = path.join(runDirectory, 'candidate-upload.log');
        const logStat = await lstat(logPath);
        const versionId = logStat.isFile() && !logStat.isSymbolicLink() && logStat.size <= 1_000_000
          ? uploadedVersionId(await readFile(logPath, 'utf8')) : null;
        return { ...result, versionId };
      },
    };
    const report = await runReleaseGate({ mode, steps });
    console.log(`${report.passed ? 'PASS' : 'BLOCKED'}: ${report.issues.length} release issue(s).`);
    for (const issue of report.issues) console.log(`- ${issue}`);
    console.log(`Report: .release-gate/runs/${runId}/report.json`);
    if (report.candidateUploaded) console.log(`Candidate uploaded as immutable version ${report.candidateVersionId}. Version URL routing remains disabled; production was not deployed.`);
    else if (report.candidateUploadAttempted) console.log('Candidate upload outcome needs inspection before any new attempt.');
    if (!report.deploymentAttempted) console.log('No deployment attempted.');
    process.exitCode = report.passed ? 0 : 1;
  }
} catch {
  console.error('Release preparation or verification failed. No deployment is authorized. Inspect inputs and any .release-gate diagnostic files.');
  process.exitCode = 1;
} finally {
  await lock.close();
  if (retainLock) console.error('A command timed out. The release lock is retained until its process tree has been checked.');
  else await unlink(path.join(stateRoot, 'active.lock'));
}
