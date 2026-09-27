// Offline structural preflight only. No model, application, network or ledger calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  ActionIdSchema, CheckInputSchema, EvidenceSchema, EvidenceStateSchema,
  QuestionIdSchema, inspectLinkInput,
} from './validation-runtime.mjs';

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--file'), 'Use no argument, or --file stress-v1.json|stress-v2.json');
const referenceFile = args[1] ?? 'stress-v2.json';
assert(['stress-v1.json', 'stress-v2.json'].includes(referenceFile), 'Choose an explicit stress reference version');
const bytes = await readFile(new URL(referenceFile, import.meta.url));
const reference = JSON.parse(bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const ids = new Set();
const modes = { message: 0, call: 0, link: 0 };
const bands = {};
let clarificationCases = 0;
const strings = (values, label) => assert(Array.isArray(values) && values.length > 0 && values.every(v => typeof v === 'string' && v.trim()), `Missing ${label}`);
const actions = (values, label) => { strings(values, label); assert.equal(values.length, new Set(values).size); values.forEach(value => ActionIdSchema.parse(value)); };
assert.equal(reference.humanReviewed, false);
assert.equal(reference.modelExecuted, false);
assert.equal(reference.cases.length, 20);
assert.equal(reference.pairs.length, 10);
assert.equal(reference.execution.automaticExecution, false);
assert.equal(reference.execution.quotaChangeAuthorizedByThisFile, false);
assert.equal(reference.execution.clarificationAnswer, 'unsure');
strings(reference.globalProhibitedOutcomes, 'global prohibited outcomes');

for (const item of reference.cases) {
  assert(/^ST\d{2}$/.test(item.id) && !ids.has(item.id), `Invalid or duplicate ID: ${item.id}`);
  ids.add(item.id);
  const input = CheckInputSchema.parse({ ...reference.defaultInput, ...item.input });
  assert(input.mode in modes, `Text-only corpus: ${item.id}`);
  assert.equal(input.externalLookup, false);
  assert.equal(input.image, undefined);
  assert.equal(input.senderEmail, '');
  assert.equal(input.senderPhone, '');
  modes[input.mode]++;
  assert(['harmful_request', 'legitimate_counterpart', 'ambiguous'].includes(item.band));
  bands[item.band] = (bands[item.band] ?? 0) + 1;
  strings(item.tags, `${item.id} tags`);
  assert(item.family && item.pairId && item.rationale);
  for (const match of [input.content, input.context].join('\n').matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const url = new URL(match[0]);
    assert(url.hostname.endsWith('.example'), `Only reserved .example hosts: ${item.id}`);
    for (const value of url.searchParams.values()) if (/^https?:\/\//.test(value)) assert(new URL(value).hostname.endsWith('.example'));
  }
  if (input.mode === 'link') assert.equal(inspectLinkInput(input.content).kind, 'website', `UI route must accept unchanged link syntax: ${item.id}`);
  const expected = item.expected;
  actions(expected.allowedActionIds, `${item.id} actions`);
  assert(expected.allowedStatuses.length > 0 && expected.allowedStatuses.every(s => ['complete', 'partial', 'needs_context'].includes(s)));
  strings(expected.mustExplain, `${item.id} explanations`);
  strings(expected.prohibitedOutcomes, `${item.id} prohibited outcomes`);
  const q = expected.clarification;
  assert(['forbidden', 'optional', 'required'].includes(q.policy));
  q.allowedQuestionIds.forEach(id => QuestionIdSchema.parse(id));
  if (q.policy === 'forbidden') {
    assert.equal(q.allowedQuestionIds.length, 0);
    assert(!expected.allowedActionIds.includes('need_context'));
    assert(!expected.allowedStatuses.includes('needs_context'));
    assert.equal(q.branches, undefined);
  } else {
    clarificationCases++;
    assert(q.allowedQuestionIds.length > 0);
    assert(expected.allowedActionIds.includes('need_context'));
    assert(expected.allowedStatuses.includes('needs_context'));
    assert.deepEqual(q.branches.map(branch => branch.answer).sort(), ['no', 'unsure', 'yes']);
    for (const branch of q.branches) {
      actions(branch.allowedActionIds, `${item.id}/${branch.answer}`);
      assert(!branch.allowedActionIds.includes('need_context'));
    }
  }
  for (const [action, condition] of Object.entries(expected.conditionalActionRequirements ?? {})) {
    assert(expected.allowedActionIds.includes(action));
    assert(typeof condition === 'string' && condition.trim());
  }
  if (referenceFile === 'stress-v2.json' && ['ST11', 'ST13'].includes(item.id)) {
    assert.equal(expected.conditionalRequirementsApplyTo, 'initial_and_post_clarification');
    for (const action of Object.keys(expected.conditionalActionRequirements)) {
      assert(expected.clarification.branches.find(branch => branch.answer === 'unsure').allowedActionIds.includes(action));
    }
  }
  for (const e of expected.evidenceRequirements ?? []) {
    EvidenceSchema.shape.kind.parse(e.kind);
    assert(e.allowedStates.length > 0);
    e.allowedStates.forEach(state => EvidenceStateSchema.parse(state));
  }
}
const paired = new Set();
for (const pair of reference.pairs) {
  assert.equal(pair.cases.length, 2);
  assert(typeof pair.contrast === 'string' && pair.contrast.trim());
  for (const id of pair.cases) {
    assert(ids.has(id) && !paired.has(id));
    assert.equal(reference.cases.find(item => item.id === id).pairId, pair.id);
    paired.add(id);
  }
}
assert.equal(paired.size, 20);
assert.deepEqual(modes, { message: 12, call: 4, link: 4 });
const separateContextCases = reference.cases.filter(item => ['message', 'call'].includes(item.input.mode) && item.input.context).map(item => item.id);
console.log(JSON.stringify({ result: 'Offline structural and link-syntax validation passed; this does not establish all UI routes or model behaviour', referenceFile, cases: 20, pairs: 10, modes, bands, clarificationCases, messageCallContextCases: separateContextCases, routeCaveat: 'ST11-ST14 require separate context controls that the current message/call UI does not expose; do not omit or concatenate the field.', urlPolicy: 'reserved .example hosts only; no lookup', sha256 }, null, 2));
