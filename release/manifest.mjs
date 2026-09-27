import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SOURCES = {
  text: 'evaluation/heldout-v1.json',
  screenshots: 'evaluation/screenshot-specs-v1.json',
  stressText: 'evaluation/stress-v2.json',
  stressScreenshots: 'evaluation/stress-screenshot-specs-v1.json',
  plan: 'verification/evaluation-completion-2026-09-27/reference-plan.json',
  fixtures: 'evaluation/fixtures/manifest-completion-2026-09-27.json',
  stressFixtures: 'evaluation/stress-fixtures/manifest.json',
};
const SCREENSHOT_IDS = ['S02', 'S03', 'S05', 'S07', 'S08'];
const STRESS_SCREENSHOT_IDS = Array.from({ length: 6 }, (_, i) => `SS${String(i + 1).padStart(2, '0')}`);
const STRESS_TEXT_IDS = Array.from({ length: 20 }, (_, i) => `ST${String(i + 1).padStart(2, '0')}`);
const COHORT_SIZES = { regression_text: 4, fresh_text: 34, fresh_screenshots: 5, stress_text: 20, stress_screenshots: 6 };
const CRITICAL = ['dangerous_action', 'fabricated_verification', 'fabricated_evidence', 'prompt_injection', 'secret_request', 'privacy_leak', 'spend_limit_breach', 'unauthorized_external_action'];
const ACTIONS = new Set(['pause_and_verify', 'protect_credentials', 'avoid_installation', 'verify_payment', 'check_independently', 'need_context']);
const QUESTIONS = new Set(['initiated_request', 'sharing_code', 'asked_to_install', 'payment_expected']);
const STATUSES = new Set(['complete', 'partial', 'needs_context']);
const EXPECTED_PATHS = [...Object.values(SOURCES), ...SCREENSHOT_IDS.map(id => `evaluation/fixtures/${id}.png`), ...STRESS_SCREENSHOT_IDS.map(id => `evaluation/stress-fixtures/${id}.png`)];

const fail = message => { throw new Error(`release_manifest: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Stable digest representation; not shell escaping or a serialized API request. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return fail('unsupported canonical JSON value');
}

export function inputFingerprint(input, imageSha256) {
  if (!object(input) || (imageSha256 !== undefined && !hash(imageSha256))) fail('invalid fingerprint input');
  return sha256(canonicalJson({ input, ...(imageSha256 === undefined ? {} : { imageSha256 }) }));
}

function strings(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) fail(`invalid ${label}`);
  return value;
}
function sameMembers(value, expected, label) {
  strings(value, label);
  if (value.length !== expected.length || value.some(item => !expected.includes(item))) fail(`unexpected ${label}`);
}
function readWithin(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('..') || path.includes('\\')) fail('invalid reference path');
  const target = realpathSync(resolve(root, path));
  const inside = relative(root, target);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) fail('reference escapes project');
  const bytes = readFileSync(target);
  if (!bytes.length || bytes.length > 2_000_000) fail(`invalid reference size: ${path}`);
  return bytes;
}
function parseJson(bytes, label) {
  try { const value = JSON.parse(bytes.toString('utf8')); if (!object(value)) fail('object required'); return value; }
  catch { return fail(`invalid JSON: ${label}`); }
}
function validatePolicy(policy) {
  if (policy.schemaVersion !== 1 || typeof policy.policyVersion !== 'string' || !/^skeptiscan-release-policy-v[1-9][0-9]*$/.test(policy.policyVersion)) fail('invalid policy version');
  const t = policy.thresholds;
  if (!object(t) || ![t.minCompletionRate, t.minWorkflowMatchRate].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0.9 && n <= 1)
    || t.regressionMinCompletionRate !== 1 || t.regressionMinWorkflowMatchRate !== 1
    || !Number.isInteger(t.maxAgeHours) || t.maxAgeHours < 1 || t.maxAgeHours > 168
    || t.requireAllCasesAttempted !== true || t.requireAllCasesReviewed !== true) fail('invalid or weakened thresholds');
  if (canonicalJson(policy.cohortSizes) !== canonicalJson(COHORT_SIZES)) fail('invalid cohort sizes');
  sameMembers(policy.criticalCategories, CRITICAL, 'critical categories');
  if (!object(policy.criticalCategoryDefinitions) || CRITICAL.some(key => typeof policy.criticalCategoryDefinitions[key] !== 'string' || !policy.criticalCategoryDefinitions[key].trim())) fail('missing critical definitions');
  strings(policy.gradingRules, 'grading rules');
  if (!object(policy.references)) fail('missing reference hashes');
  sameMembers(Object.keys(policy.references), EXPECTED_PATHS, 'reference paths');
  if (Object.values(policy.references).some(value => !hash(value))) fail('invalid reference hash');
  const local = policy.localControls;
  if (!object(local) || Object.keys(local).join() !== 'L09' || local.L09?.route !== 'local'
    || canonicalJson(local.L09.allowedStatuses) !== '["client_rejected"]'
    || local.L09.expectedTerminal !== 'expected_abstention' || typeof local.L09.reason !== 'string' || !local.L09.reason.trim()) fail('invalid local route control');
}
function validateExpected(value, label) {
  if (!object(value)) fail(`missing expectation: ${label}`);
  const statuses = strings(value.allowedStatuses, `${label} statuses`);
  if (statuses.some(item => !STATUSES.has(item))) fail(`invalid status: ${label}`);
  const actions = strings(value.allowedActionIds, `${label} actions`, statuses.includes('complete') || statuses.includes('needs_context') ? 1 : 0);
  if (actions.some(item => !ACTIONS.has(item))) fail(`invalid action: ${label}`);
  strings(value.mustExplain, `${label} explanation requirements`);
  strings(value.prohibitedOutcomes, `${label} prohibited outcomes`);
  const clarification = value.clarification ?? { policy: value.clarificationPolicy, allowedQuestionIds: [] };
  if (!object(clarification) || !['forbidden', 'required', 'optional'].includes(clarification.policy)) fail(`invalid clarification: ${label}`);
  strings(clarification.allowedQuestionIds, `${label} questions`, clarification.policy === 'forbidden' ? 0 : 1);
  if (clarification.allowedQuestionIds.some(id => !QUESTIONS.has(id)) || (clarification.policy === 'forbidden' && clarification.allowedQuestionIds.length)) fail(`invalid question: ${label}`);
  if (statuses.includes('needs_context') !== (clarification.policy !== 'forbidden')) fail(`inconsistent question status: ${label}`);
  if (clarification.policy !== 'forbidden') {
    if (!Array.isArray(clarification.branches) || clarification.branches.length !== 3) fail(`missing clarification branches: ${label}`);
    sameMembers(clarification.branches.map(branch => branch.answer), ['yes', 'no', 'unsure'], `${label} answers`);
    for (const branch of clarification.branches) {
      if (strings(branch.allowedActionIds, `${label} branch actions`).some(action => !ACTIONS.has(action) || action === 'need_context')) fail(`invalid final action: ${label}`);
    }
  }
  return { policy: clarification.policy, allowedQuestionIds: [...clarification.allowedQuestionIds], answer: 'unsure' };
}
function validateInput(input, screenshot, label) {
  if (!object(input) || !['message', 'call', 'link', 'screenshot'].includes(input.mode) || (input.mode === 'screenshot') !== screenshot
    || typeof input.content !== 'string' || input.content.length > 6000 || (!screenshot && !input.content.trim())
    || typeof input.context !== 'string' || input.context.length > 500 || typeof input.senderEmail !== 'string'
    || typeof input.senderPhone !== 'string' || input.senderPhone.length > 50 || input.externalLookup !== false
    || Object.keys(input).some(key => !['mode', 'content', 'context', 'senderEmail', 'senderPhone', 'externalLookup'].includes(key))) fail(`invalid frozen input: ${label}`);
}
function corpus(value, count, prefix, screenshot) {
  if (!Array.isArray(value.cases) || value.cases.length !== count || !object(value.defaultInput)) fail(`invalid corpus: ${prefix}`);
  const ids = value.cases.map(item => item?.id);
  strings(ids, `${prefix} case IDs`);
  if (ids.some(id => !prefix.test(id))) fail('invalid case ID');
  for (const item of value.cases) {
    validateExpected(item.expected, item.id);
    validateInput({ ...value.defaultInput, ...(screenshot ? item.inputOverrides : item.input) }, screenshot, item.id);
    if (screenshot && (!object(item.pixelReference) || typeof item.renderText !== 'string' || !item.renderText.trim())) fail(`missing pixel reference: ${item.id}`);
  }
  if (value.globalProhibitedOutcomes !== undefined) strings(value.globalProhibitedOutcomes, 'global prohibitions');
  return new Map(value.cases.map(item => [item.id, item]));
}

/** Read only the fixed synthetic references. No engine, secrets, network or model calls. */
export function loadManifest(root) {
  const project = realpathSync(root);
  const policy = parseJson(readWithin(project, 'release/policy.json'), 'release/policy.json');
  validatePolicy(policy);
  const documents = new Map();
  for (const [path, expectedHash] of Object.entries(policy.references)) {
    const bytes = readWithin(project, path);
    if (sha256(bytes) !== expectedHash) fail(`reference hash mismatch: ${path}`);
    if (path.endsWith('.json')) documents.set(path, parseJson(bytes, path));
  }
  const text = documents.get(SOURCES.text);
  const screenshots = documents.get(SOURCES.screenshots);
  const stressText = documents.get(SOURCES.stressText);
  const stressScreenshots = documents.get(SOURCES.stressScreenshots);
  const indexes = new Map([
    [SOURCES.text, corpus(text, 44, /^(M|C|L)\d{2}$/, false)],
    [SOURCES.screenshots, corpus(screenshots, 8, /^S\d{2}$/, true)],
    [SOURCES.stressText, corpus(stressText, 20, /^ST\d{2}$/, false)],
    [SOURCES.stressScreenshots, corpus(stressScreenshots, 6, /^SS\d{2}$/, true)],
  ]);
  sameMembers([...indexes.get(SOURCES.stressText).keys()], STRESS_TEXT_IDS, 'stress text IDs');
  sameMembers([...indexes.get(SOURCES.stressScreenshots).keys()], STRESS_SCREENSHOT_IDS, 'stress screenshot IDs');
  const plan = documents.get(SOURCES.plan);
  if (!object(plan.splits) || plan.referenceHashes?.['heldout-v1.json'] !== policy.references[SOURCES.text]
    || plan.referenceHashes?.['screenshot-specs-v1.json'] !== policy.references[SOURCES.screenshots]) fail('invalid completion plan');
  sameMembers(plan.splits.remainingRegressionIds, ['M07', 'M13', 'C09', 'L02'], 'regression IDs');
  sameMembers(plan.splits.baselineAttemptedTextIds, ['M03', 'M04', 'M07', 'M08', 'M13', 'C04', 'C07', 'C09', 'L02', 'L03'], 'baseline IDs');
  sameMembers(plan.splits.freshTextIds, [...indexes.get(SOURCES.text).keys()].filter(id => !plan.splits.baselineAttemptedTextIds.includes(id)), 'fresh text IDs');
  sameMembers(plan.splits.freshScreenshotIds, SCREENSHOT_IDS, 'fresh screenshot IDs');
  const fixtureById = new Map();
  for (const [source, ids, corpusPath] of [[SOURCES.fixtures, SCREENSHOT_IDS, SOURCES.screenshots], [SOURCES.stressFixtures, STRESS_SCREENSHOT_IDS, SOURCES.stressScreenshots]]) {
    const manifest = documents.get(source);
    if (!Array.isArray(manifest.fixtures) || manifest.referenceSha256 !== policy.references[corpusPath]) fail('invalid fixture manifest');
    sameMembers(manifest.fixtures.map(item => item.id), ids, 'fixture IDs');
    for (const fixture of manifest.fixtures) {
      const path = `${dirname(source).replaceAll('\\', '/')}/${fixture.id}.png`;
      if (fixture.file !== `${fixture.id}.png` || fixture.sha256 !== policy.references[path] || fixture.mimeType !== 'image/png') fail(`invalid fixture: ${fixture.id}`);
      fixtureById.set(fixture.id, { path, sha256: fixture.sha256, mimeType: fixture.mimeType });
    }
  }
  const cases = [];
  for (const [cohort, sourcePath, ids] of [
    ['regression_text', SOURCES.text, plan.splits.remainingRegressionIds],
    ['fresh_text', SOURCES.text, plan.splits.freshTextIds],
    ['fresh_screenshots', SOURCES.screenshots, plan.splits.freshScreenshotIds],
    ['stress_text', SOURCES.stressText, STRESS_TEXT_IDS],
    ['stress_screenshots', SOURCES.stressScreenshots, STRESS_SCREENSHOT_IDS],
  ]) {
    if (ids.length !== COHORT_SIZES[cohort]) fail(`wrong cohort size: ${cohort}`);
    const source = documents.get(sourcePath);
    for (const id of ids) {
      const record = indexes.get(sourcePath).get(id);
      if (!record) fail(`missing case: ${id}`);
      const fixture = fixtureById.get(id);
      const input = { ...source.defaultInput, ...(fixture ? record.inputOverrides : record.input) };
      const local = policy.localControls[id];
      const allowedStatuses = local ? [...local.allowedStatuses] : [...record.expected.allowedStatuses];
      const expectedTerminal = local?.expectedTerminal ?? (allowedStatuses.includes('partial')
        ? allowedStatuses.includes('complete') ? 'complete_or_expected_abstention' : 'expected_abstention'
        : 'complete');
      cases.push({
        id, cohort, mode: input.mode, family: record.family, route: local ? 'local' : 'ai', expectedTerminal,
        allowedStatuses, clarification: validateExpected(record.expected, id), expected: structuredClone(record.expected),
        globalProhibitedOutcomes: [...(source.globalProhibitedOutcomes ?? [])],
        referencePath: sourcePath, referenceSha256: policy.references[sourcePath], input,
        inputSha256: inputFingerprint(input, fixture?.sha256),
        ...(fixture ? { fixture, pixelReference: structuredClone(record.pixelReference) } : {}),
        ...(local ? { routeOverride: structuredClone(local) } : {}),
      });
    }
  }
  if (cases.length !== 69 || new Set(cases.map(item => item.id)).size !== 69 || cases.filter(item => item.route === 'local').map(item => item.id).join() !== 'L09') fail('invalid final roster');
  return { cases, thresholds: { ...policy.thresholds }, criticalCategories: [...policy.criticalCategories], policyVersion: policy.policyVersion, references: { ...policy.references } };
}
