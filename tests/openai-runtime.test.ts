import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

// Bundle the actual SDK and app schemas for workerd. All outbound requests are
// intercepted locally; no secret, live provider, account or .dev.vars is used.
let script: string;
beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import { createModelGateway } from './server/openai';
      export default { async fetch() {
        const gateway = createModelGateway('offline-test-key');
        const input = {mode:'message',content:'A caller asked me to read out the one-time login code sent to my phone so they can verify my account. I did not contact them first.',context:'',senderEmail:'',senderPhone:'',externalLookup:false};
        const signal = new AbortController().signal;
        try {
          const extracted = await gateway.extract(input, signal);
          const reviewed = await gateway.review(input, extracted.value, [], signal);
          return Response.json({ok:true,action:reviewed.value.actionId,finding:reviewed.value.finding,extractUsage:extracted.usage,reviewUsage:reviewed.usage});
        } catch(error) { return Response.json({ok:false,code:error.code ?? 'unexpected',usage:error.usage}); }
      }};
    `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    conditions: ['workerd', 'browser'], external: ['node:*'], logLevel: 'silent',
  });
  script = result.outputFiles[0].text;
});

function runtime(handler: (request: Request) => Promise<Response>) {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'offline-model-gateway', modules: true, script,
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'],
    outboundService: handler,
  }));
}

describe('real SDK in workerd, with an offline provider transport', () => {
  it('constructs both strict schemas, dispatches and parses both stages', async () => {
    const requests: { url: string; model: string; strict: boolean; schemaName: string; fields: string[] }[] = [];
    const mf = runtime(async request => {
      const body = await request.json() as { model: string; text: { format: { strict: boolean; name: string; schema: { properties: Record<string, unknown> } } } };
      requests.push({ url: request.url, model: body.model, strict: body.text.format.strict, schemaName: body.text.format.name, fields: Object.keys(body.text.format.schema.properties).sort() });
      if (request.url !== 'https://api.openai.com/v1/responses') return new Response('{}', { status: 400 });
      const value = body.model.includes('mini') ? {
        transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [],
        requestedActions: [{ action: 'share a login code', quote: 'read out the one-time login code', source: 'content' }],
        screenshotIssues: [], missingContext: [],
      } : {
        finding: 'credential_disclosure', evidenceIds: [],
        questionId: null,
        rationale: { relation: 'action_risk', anchors: [{ source: 'content', quote: 'read out the one-time login code' }], risks: [{ kind: 'account_access', anchorIndex: 0 }] },
      };
      return Response.json({
        id: 'resp_offline', object: 'response', model: body.model, status: 'completed',
        output: [{ id: 'msg_offline', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', annotations: [], text: JSON.stringify(value) }] }],
        usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      });
    });
    try {
      const result = await (await mf.dispatchFetch('http://localhost/')).json();
      expect(result).toMatchObject({ ok: true, action: 'protect_credentials', finding: 'credential_disclosure', extractUsage: { costMicroUsd: 525 }, reviewUsage: { costMicroUsd: 1750 } });
      expect(requests).toHaveLength(2);
      expect(requests.every(item => item.url === 'https://api.openai.com/v1/responses' && item.strict)).toBe(true);
      expect(requests[0].model).not.toBe(requests[1].model);
      expect(requests[0].schemaName).toBe('skeptiscan_extraction');
      expect(requests[1]).toMatchObject({ schemaName: 'skeptiscan_review', fields: ['evidenceIds', 'finding', 'questionId', 'rationale'] });
    } finally { await mf.dispose(); }
  });

  it('rejects a provider redirect without retrying or sending a request to its destination', async () => {
    const destinations: string[] = [];
    const mf = runtime(async request => {
      destinations.push(request.url);
      return new Response('{}', { status: 302, headers: { Location: 'https://must-not-follow.invalid/', 'Content-Type': 'application/json' } });
    });
    try {
      expect(await (await mf.dispatchFetch('http://localhost/')).json()).toEqual({ ok: false, code: 'BILLING_UNKNOWN' });
      expect(destinations).toEqual(['https://api.openai.com/v1/responses']);
    } finally { await mf.dispose(); }
  });

  it.each([
    ['malformed extraction text', 1, 'malformed', 'MODEL_OUTPUT_INVALID', 525],
    ['malformed review text', 2, 'malformed', 'MODEL_OUTPUT_INVALID', 1750],
    ['explicit extraction refusal', 1, 'refusal', 'MODEL_REFUSAL', 525],
  ] as const)('keeps known billing through the actual SDK for %s', async (_label, failStage, failure, expectedCode, costMicroUsd) => {
    let calls = 0;
    const mf = runtime(async request => {
      calls++;
      const body = await request.json() as { model: string };
      const extraction = { transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [],
        requestedActions: [{ action: 'share a login code', quote: 'read out the one-time login code', source: 'content' }], screenshotIssues: [], missingContext: [] };
      const content = calls === failStage
        ? failure === 'refusal' ? [{ type: 'refusal', refusal: 'Offline refusal fixture' }]
          : [{ type: 'output_text', annotations: [], text: '{"unfinished":' }]
        : [{ type: 'output_text', annotations: [], text: JSON.stringify(extraction) }];
      return Response.json({ id: 'resp_offline_invalid', object: 'response', model: body.model, status: 'completed',
        output: [{ id: 'msg_offline_invalid', type: 'message', status: 'completed', role: 'assistant', content }],
        usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      });
    });
    try {
      expect(await (await mf.dispatchFetch('http://localhost/')).json()).toMatchObject({ ok: false, code: expectedCode, usage: { costMicroUsd } });
      expect(calls).toBe(failStage);
    } finally { await mf.dispose(); }
  });
});
