import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
// @ts-expect-error This release tool intentionally runs as standalone Node ESM.
import { loadManifest } from '../release/manifest.mjs';
import { CheckInputSchema, EvidenceSchema, ExtractionSchema, QuestionIdSchema, type CheckInput, type Extraction, type Evidence } from '../shared/contracts';
import { findExactQuoteSpan, quoteSourcesFor } from '../server/grounding';

const sdk = vi.hoisted(() => ({ create: vi.fn(), count: vi.fn() }));
vi.mock('openai', () => ({ default: class {
  responses = { create: sdk.create, inputTokens: { count: sdk.count } };
} }));
import { conservativeTextTokenBound, createModelGateway, MODEL_LIMITS } from '../server/openai';

interface PlannedCase { id: string; route: 'ai' | 'local'; input: Omit<CheckInput, 'image'>; fixture?: { path: string; mimeType: 'image/png' } }
interface Capture {
  attempts: { observation: { kind: string; questionId: string | null }; answer?: 'yes' | 'no' | 'unsure';
    response: { body: { extraction?: unknown; evidence?: unknown[] } } | null }[];
}
const project = fileURLToPath(new URL('../', import.meta.url));
const planned: PlannedCase[] = loadManifest(project).cases;
const mini = 'gpt-5.4-mini-2026-03-17';
const reviewer = 'gpt-5.4-2026-03-05';
const nativeEncode = TextEncoder.prototype.encode;
const measurements: { id: string; stage: string; model: typeof mini | typeof reviewer; bound: number }[] = [];
let frames: { stage: string; body: ResponseCreateParamsNonStreaming }[];
let activeStage: string;
let collectFrames: boolean;
const emptyExtraction: Extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], screenshotIssues: [], missingContext: [] };

// Historical synthetic captures are read only for payload length/shape. They are
// never regraded, rewritten, or treated as current live model evidence. The L09
// local control is measured only at this mocked gateway, not admitted by the app.
// Mock image counts prove dispatch wiring; they do not estimate real image tokens.
beforeEach(() => {
  frames = []; activeStage = ''; collectFrames = true;
  sdk.count.mockReset().mockResolvedValue({ object: 'response.input_tokens', input_tokens: 1000 });
  sdk.create.mockReset().mockImplementation(async (body: ResponseCreateParamsNonStreaming) => {
    const value = body.model === mini
      ? { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], screenshotIssues: [], missingContext: [] }
      : { finding: 'identity_unknown', evidenceIds: [], questionId: null, rationale: null };
    return { model: body.model, status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
      usage: { input_tokens: 1000, output_tokens: 100 } };
  });
  // Observe the exact serialized text projection inside the gateway's guard,
  // including the actual prompt/schema/framing, even when it rejects pre-dispatch.
  vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, text?: string) {
    const bytes = nativeEncode.call(this, text);
    if (collectFrames && typeof text === 'string' && text.startsWith('{"model":')) {
      const body = JSON.parse(text);
      if ([mini, reviewer].includes(body.model) && body.text?.format?.type === 'json_schema') frames.push({ stage: activeStage, body });
    }
    return bytes;
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  const maxima = [mini, reviewer].map(model => measurements.filter(row => row.model === model).sort((a, b) => b.bound - a.bound)[0]);
  console.info('Offline serialized request bounds (not live token estimates):', JSON.stringify(maxima));
});

function historyShape(attempt: Capture['attempts'][number]): { extraction: Extraction; evidence: Evidence[] } {
  return {
    extraction: attempt.response?.body.extraction ? ExtractionSchema.parse(attempt.response.body.extraction) : structuredClone(emptyExtraction),
    evidence: (attempt.response?.body.evidence ?? []).map(value => EvidenceSchema.parse(value)),
  };
}

function groundedShape(input: CheckInput, extraction: Extraction): Extraction {
  const sources = quoteSourcesFor(input, extraction);
  return { ...extraction, screenshotIssues: extraction.screenshotIssues ?? [], requestedActions: extraction.requestedActions.map(action => {
    const match = findExactQuoteSpan(action.quote, sources, action.source);
    return match.matched ? { ...action, source: match.span.source, span: match.span } : action;
  }) };
}

describe('all frozen manifest inputs fit the current gateway text/schema envelopes (mock SDK only)', () => {
  it('keeps all 69 cases including the separately labelled local control in this size check', () => {
    expect(planned).toHaveLength(69);
    expect(new Set(planned.map(item => item.id)).size).toBe(69);
    expect(planned.filter(item => item.route === 'local').map(item => item.id)).toEqual(['L09']);
  });

  it.each(planned)('$id reaches each mocked stage with historical payload shapes under unchanged bounds', async item => {
    const input = CheckInputSchema.parse({ ...item.input, ...(item.fixture ? {
      image: { mimeType: item.fixture.mimeType, base64: readFileSync(resolve(project, item.fixture.path), 'base64') },
    } : {}) });
    const capture: Capture = JSON.parse(readFileSync(resolve(project, 'evaluation/release-captures/candidate-83256009', `${item.id}.capture.json`), 'utf8'));
    const initial = historyShape(capture.attempts[0]);
    const gateway = createModelGateway('offline-size-check-key');
    const failures: string[] = [];
    const signal = new AbortController().signal;

    async function stage(label: string, model: typeof mini | typeof reviewer, call: () => Promise<unknown>) {
      activeStage = label;
      const callsBefore = sdk.create.mock.calls.length;
      const countsBefore = sdk.count.mock.calls.length;
      let errorCode: string | undefined;
      try { await call(); } catch (error) { errorCode = error instanceof Error && 'code' in error ? String(error.code) : 'unexpected'; }
      const frame = frames.filter(value => value.stage === label).at(-1);
      collectFrames = false;
      const bound = frame ? conservativeTextTokenBound(frame.body) : NaN;
      collectFrames = true;
      measurements.push({ id: item.id, stage: label, model, bound });
      const prefix = `${item.id}/${label}: serialized text bound ${bound}/${MODEL_LIMITS[model].inputTokens}`;
      if (!frame || !Number.isFinite(bound) || bound > MODEL_LIMITS[model].inputTokens || errorCode) failures.push(`${prefix}; ${errorCode ?? 'invalid bound'}`);
      if (sdk.create.mock.calls.length !== callsBefore + 1) failures.push(`${prefix}; generation did not reach the mocked SDK exactly once`);
      if (sdk.count.mock.calls.length !== countsBefore + (input.image ? 1 : 0)) failures.push(`${prefix}; unexpected mocked image-count dispatch`);
      if (input.image && sdk.create.mock.calls.length === callsBefore + 1) {
        const countBody = sdk.count.mock.calls.at(-1)![0];
        const generationBody = sdk.create.mock.calls.at(-1)![0];
        for (const key of ['model', 'input', 'instructions', 'text', 'reasoning', 'tools']) expect(countBody[key]).toEqual(generationBody[key]);
      }
    }

    await stage('extraction', mini, () => gateway.extract(input, signal));
    await stage('review-historical', reviewer, () => gateway.review(input, initial.extraction, initial.evidence, signal));
    await stage('review-with-exact-source-spans', reviewer, () => gateway.review(input, groundedShape(input, initial.extraction), initial.evidence, signal));
    for (const [index, attempt] of capture.attempts.entries()) {
      if (attempt.observation.kind !== 'clarification') continue;
      const shape = historyShape(attempt);
      const questionId = QuestionIdSchema.parse(capture.attempts[0].observation.questionId);
      expect(attempt.answer).toBe('unsure');
      await stage(`historical-clarification-${index}`, reviewer, () => gateway.review(input, groundedShape(input, shape.extraction), shape.evidence, signal, { questionId, answer: attempt.answer! }));
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
