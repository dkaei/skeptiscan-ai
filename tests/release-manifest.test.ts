import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// @ts-expect-error This release tool intentionally runs as standalone Node ESM.
import { canonicalJson, inputFingerprint, loadManifest } from '../release/manifest.mjs';

interface PlannedCase {
  id: string; cohort: string; route: string; expectedTerminal: string; allowedStatuses: string[];
  clarification: { policy: string; allowedQuestionIds: string[]; answer: string };
  expected: { allowedStatuses: string[]; clarification?: { branches: { answer: string; allowedActionIds: string[] }[] }; acceptableOutcomes?: unknown[] };
  input: Record<string, unknown>; inputSha256: string;
  fixture?: { path: string; sha256: string }; routeOverride?: { reason: string };
}
interface Manifest { cases: PlannedCase[]; thresholds: Record<string, number | boolean>; references: Record<string, string>; criticalCategories: string[] }
const project = fileURLToPath(new URL('../', import.meta.url));
const load = (root = project): Manifest => loadManifest(root);
const temporary: string[] = [];
function copyReferences() {
  const root = mkdtempSync(join(tmpdir(), 'skeptiscan-manifest-test-'));
  temporary.push(root);
  for (const path of ['release/policy.json', ...Object.keys(load().references)]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(project, path), join(root, path));
  }
  return root;
}
function changePolicy(root: string, mutate: (value: Record<string, any>) => void) {
  const path = join(root, 'release/policy.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value); writeFileSync(path, JSON.stringify(value));
}
afterEach(() => {
  for (const path of temporary.splice(0)) {
    // Delete only directories returned by this test's own fixed-prefix mkdtemp.
    if (dirname(path) !== tmpdir() || !path.startsWith(join(tmpdir(), 'skeptiscan-manifest-test-'))) throw new Error('Unexpected test directory');
    rmSync(path, { recursive: true, force: true });
  }
});

describe('frozen release roster and input identity', () => {
  it('loads 69 distinct cases with one local control outside AI denominators', () => {
    const m = load();
    expect(m.cases).toHaveLength(69); expect(new Set(m.cases.map(c => c.id)).size).toBe(69);
    expect(m.cases.filter(c => c.route === 'ai')).toHaveLength(68);
    expect(m.cases.filter(c => c.route === 'local').map(c => c.id)).toEqual(['L09']);
    expect(Object.fromEntries(['regression_text', 'fresh_text', 'fresh_screenshots', 'stress_text', 'stress_screenshots'].map(cohort => [cohort, m.cases.filter(c => c.cohort === cohort).length])))
      .toEqual({ regression_text: 4, fresh_text: 34, fresh_screenshots: 5, stress_text: 20, stress_screenshots: 6 });
    expect(m.thresholds).toMatchObject({ minCompletionRate: 0.9, minWorkflowMatchRate: 0.9, regressionMinCompletionRate: 1, regressionMinWorkflowMatchRate: 1, maxAgeHours: 168, requireAllCasesAttempted: true, requireAllCasesReviewed: true });
  });

  it('keeps the original L09 reference visible beside its explicit browser-route criterion', () => {
    const c = load().cases.find(c => c.id === 'L09')!;
    expect(c).toMatchObject({ route: 'local', allowedStatuses: ['client_rejected'], expectedTerminal: 'expected_abstention', expected: { allowedStatuses: ['complete'] } });
    expect(c.input.content).toBe("javascript:alert('synthetic-demo')");
    expect(c.routeOverride?.reason).toContain('not a retrospective model pass');
  });

  it('keeps initial clarification distinct from terminal completion and preserves the revised unsure branch', () => {
    const cases = load().cases;
    expect(cases.find(c => c.id === 'M17')).toMatchObject({ allowedStatuses: ['needs_context'], expectedTerminal: 'complete', clarification: { policy: 'required', allowedQuestionIds: ['sharing_code'], answer: 'unsure' } });
    const branch = cases.find(c => c.id === 'ST11')!.expected.clarification!.branches.find(b => b.answer === 'unsure');
    expect(branch?.allowedActionIds).toContain('protect_credentials');
  });

  it('distinguishes necessary abstention, an absent destination and genuinely flexible cropped text', () => {
    const cases = load().cases;
    for (const id of ['S05', 'SS01', 'SS03']) expect(cases.find(c => c.id === id)?.expectedTerminal).toBe('expected_abstention');
    for (const id of ['S07', 'SS02']) expect(cases.find(c => c.id === id)?.expectedTerminal).toBe('complete');
    const crop = cases.find(c => c.id === 'SS06')!;
    expect(crop.expectedTerminal).toBe('complete_or_expected_abstention');
    expect(crop.expected.acceptableOutcomes).toHaveLength(2);
  });

  it('binds exact context/correction and actual pixel hashes without supplying hidden authoring text', () => {
    const cases = load().cases;
    const ownLogin = cases.find(c => c.id === 'S02')!;
    expect(ownLogin.input.context).toBe('I started this sign-in in the app I normally use. No person is asking me for the code.');
    expect(ownLogin.input.content).toBe('');
    expect(ownLogin.input).not.toHaveProperty('image'); expect(ownLogin.input).not.toHaveProperty('renderText');
    expect(ownLogin.inputSha256).toBe(inputFingerprint(ownLogin.input, ownLogin.fixture!.sha256));
    expect(ownLogin.inputSha256).not.toBe(inputFingerprint({ ...ownLogin.input, context: '' }, ownLogin.fixture!.sha256));
    expect(cases.find(c => c.id === 'S05')!.input.content).toContain('Nobody is asking me to send it');
  });

  it('uses order-independent object digests but preserves typed values and array order', () => {
    expect(canonicalJson({ b: [1, 2], a: false })).toBe(canonicalJson({ a: false, b: [1, 2] }));
    expect(inputFingerprint({ a: false })).not.toBe(inputFingerprint({ a: 'false' }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

describe('reference and policy corruption cannot become a green manifest', () => {
  it.each(['evaluation/heldout-v1.json', 'evaluation/fixtures/S05.png'])('rejects modified bytes in %s', path => {
    const root = copyReferences(); const file = join(root, path);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('changed')]));
    expect(() => load(root)).toThrow('reference hash mismatch');
  });

  it('rejects a missing planned fixture', () => {
    const root = copyReferences(); rmSync(join(root, 'evaluation/stress-fixtures/SS06.png'));
    expect(() => load(root)).toThrow();
  });

  it.each(['empty_categories', 'weaker_threshold', 'skip_unreviewed', 'missing_hash', 'extra_path'])('rejects %s policy changes', variant => {
    const root = copyReferences();
    changePolicy(root, p => {
      if (variant === 'empty_categories') p.criticalCategories = [];
      if (variant === 'weaker_threshold') p.thresholds.minCompletionRate = 0.1;
      if (variant === 'skip_unreviewed') p.thresholds.requireAllCasesReviewed = false;
      if (variant === 'missing_hash') delete p.references['evaluation/heldout-v1.json'];
      if (variant === 'extra_path') p.references['.dev.vars'] = '0'.repeat(64);
    });
    expect(() => load(root)).toThrow('release_manifest');
  });

  it('still validates reference structure if a replacement hash is deliberately recorded', () => {
    const root = copyReferences(); const path = 'evaluation/stress-v2.json';
    const value = JSON.parse(readFileSync(join(root, path), 'utf8')); value.cases = [];
    const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(join(root, path), bytes);
    changePolicy(root, p => { p.references[path] = createHash('sha256').update(bytes).digest('hex'); });
    expect(() => load(root)).toThrow('invalid corpus');
  });
});
