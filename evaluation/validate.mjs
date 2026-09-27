// Offline structural checks only. No credentials, provider calls or app state changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ActionIdSchema, CheckInputSchema, EvidenceSchema, EvidenceStateSchema, QuestionIdSchema,
} from './validation-runtime.mjs';

const files = ['heldout-v1.json', 'screenshot-specs-v1.json', 'invalid-input-v1.json'];
const parsed = [];
const hashes = {};
for (const name of files) {
  const bytes = await readFile(new URL(name, import.meta.url));
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  parsed.push(JSON.parse(bytes.toString('utf8')));
}
const [holdout, screenshots, invalid] = parsed;
const ids = new Set();
function uniqueId(item) {
  assert.equal(typeof item.id, 'string');
  assert(!ids.has(item.id), `Duplicate case ${item.id}`);
  ids.add(item.id);
  assert.equal(typeof item.rationale, 'string');
  assert(item.rationale.trim(), `Missing rationale: ${item.id}`);
}
function actions(values, label, allowEmpty = false) {
  assert(Array.isArray(values) && (allowEmpty || values.length), `Missing actions: ${label}`);
  assert.equal(new Set(values).size, values.length, `Duplicate actions: ${label}`);
  for (const value of values) ActionIdSchema.parse(value);
}
function strings(values, label) {
  assert(Array.isArray(values) && values.length, `Missing ${label}`);
  assert(values.every(value => typeof value === 'string' && value.trim()), `Empty ${label}`);
}
assert.equal(holdout.humanReviewed, false);
assert.equal(holdout.intendedSplit, 'holdout');
assert(holdout.cases.length >= 40);
strings(holdout.globalProhibitedOutcomes, 'global prohibited outcomes');
const counts = { message: 0, call: 0, link: 0 };
const bands = {};
let clarificationCases = 0;
for (const item of holdout.cases) {
  uniqueId(item);
  const input = CheckInputSchema.parse({ ...holdout.defaultInput, ...item.input });
  assert(input.mode in counts, `Unexpected modality: ${item.id}`);
  assert.equal(input.externalLookup, false, `Lookup must stay off: ${item.id}`);
  assert.equal(input.image, undefined, `Pixels belong in the separate set: ${item.id}`);
  counts[input.mode]++;
  assert(['harmful_request', 'legitimate_counterpart', 'ambiguous'].includes(item.band));
  bands[item.band] = (bands[item.band] ?? 0) + 1;
  strings(item.tags, `${item.id} tags`);
  assert.equal(typeof item.family, 'string');
  const e = item.expected;
  actions(e.allowedActionIds, item.id);
  strings(e.mustExplain, `${item.id} explanation criteria`);
  strings(e.prohibitedOutcomes, `${item.id} prohibited outcomes`);
  assert(e.allowedStatuses.length && e.allowedStatuses.every(s => ['complete', 'needs_context', 'partial'].includes(s)));
  const q = e.clarification;
  assert(['forbidden', 'optional', 'required'].includes(q.policy));
  q.allowedQuestionIds.forEach(id => QuestionIdSchema.parse(id));
  if (q.policy === 'forbidden') {
    assert.equal(q.allowedQuestionIds.length, 0);
    assert(!e.allowedActionIds.includes('need_context'));
    assert(!e.allowedStatuses.includes('needs_context'));
    assert.equal(q.branches, undefined);
  } else {
    clarificationCases++;
    assert(q.allowedQuestionIds.length);
    assert(e.allowedActionIds.includes('need_context'));
    assert(e.allowedStatuses.includes('needs_context'));
    assert.deepEqual(q.branches.map(branch => branch.answer).sort(), ['no', 'unsure', 'yes']);
    for (const branch of q.branches) {
      actions(branch.allowedActionIds, `${item.id}/${branch.answer}`);
      assert(!branch.allowedActionIds.includes('need_context'), 'No second clarification is permitted');
    }
    if (q.policy === 'required') {
      assert.deepEqual(e.allowedActionIds, ['need_context']);
      assert.deepEqual(e.allowedStatuses, ['needs_context']);
    }
  }
  for (const requirement of e.evidenceRequirements ?? []) {
    EvidenceSchema.shape.kind.parse(requirement.kind);
    requirement.allowedStates.forEach(state => EvidenceStateSchema.parse(state));
  }
}
assert.deepEqual(counts, { message: 24, call: 10, link: 10 });
for (const item of screenshots.cases) {
  uniqueId(item);
  assert.equal(screenshots.humanReviewed, false);
  assert.equal(item.image, undefined, 'Specifications are not pixel assets');
  assert.equal(item.assetPath, undefined, 'Only claim paths after materializing pixels');
  assert.equal(typeof item.renderText, 'string');
  assert.equal(typeof item.assetInstruction, 'string');
  for (const span of item.pixelReference.readableConsequentialSpans) {
    assert(item.renderText.includes(span), `Reference span absent from render text: ${item.id}`);
  }
  actions(item.expected.allowedActionIds, item.id, true);
  assert.equal(item.expected.clarificationPolicy, 'forbidden');
  if (item.expected.allowedStatuses.includes('partial')) assert.equal(item.expected.allowedActionIds.length, 0);
  strings(item.expected.mustExplain, `${item.id} explanation criteria`);
  strings(item.expected.prohibitedOutcomes, `${item.id} prohibited outcomes`);
  const skeleton = { ...screenshots.defaultInput, ...item.inputOverrides };
  assert.equal(skeleton.externalLookup, false);
  assert.equal(skeleton.mode, 'screenshot');
  assert.equal(CheckInputSchema.safeParse(skeleton).success, false, 'No executable image payload exists yet');
}
for (const item of invalid.cases) {
  uniqueId(item);
  const input = { ...invalid.defaultInput, ...item.inputOverrides };
  if (item.repeatField) {
    const { field, character, count } = item.repeatField;
    assert.equal(field, 'content');
    assert.equal(character.length, 1);
    assert(count > 6000 && count < 10000);
    input[field] = character.repeat(count);
  }
  assert.equal(CheckInputSchema.safeParse(input).success, false, `Control unexpectedly valid: ${item.id}`);
}
console.log(JSON.stringify({
  result: 'Offline structural validation passed; no AI or HTTP evaluation performed',
  validTextCases: holdout.cases.length, modalities: counts, bands,
  clarificationCases, screenshotSpecifications: screenshots.cases.length,
  invalidSchemaControls: invalid.cases.length, sha256: hashes,
}, null, 2));
