import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

// Actual workerd fetch semantics with every outbound call intercepted locally.
// The fake key is test data; no Google account or external network is involved.
let script: string;
beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import { collectEvidence } from './server/evidence';
      export default { async fetch() {
        let reservations = 0;
        const input = {mode:'link',content:'https://example.org/',context:'',senderEmail:'',senderPhone:'',externalLookup:true};
        const evidence = await collectEvidence(input, null, {
          webRiskEnabled:true,webRiskKey:'offline-test-key',
          reserveLookup:async()=>{reservations++;},
          signal:new AbortController().signal,now:new Date('2026-09-26T12:00:00Z')
        });
        return Response.json({reservations,reputation:evidence.find(item=>item.kind==='reputation')});
      }};
    `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    conditions: ['workerd', 'browser'], external: ['node:*'], logLevel: 'silent',
  });
  script = result.outputFiles[0].text;
});

function runtime(handler: (request: Request) => Promise<Response>) {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'offline-web-risk', modules: true, script,
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'],
    outboundService: handler,
  }));
}

describe('Web Risk native workerd transport with a local fake provider', () => {
  it('reserves and checks an eligible origin using only the fixed provider endpoint', async () => {
    const destinations: string[] = [];
    const mf = runtime(async request => {
      destinations.push(request.url);
      return Response.json({});
    });
    try {
      const result = await (await mf.dispatchFetch('http://localhost/')).json();
      expect(result).toMatchObject({ reservations: 1, reputation: { state: 'no_match', detail: expect.stringContaining('does not establish safety') } });
      expect(destinations).toHaveLength(1);
      const endpoint = new URL(destinations[0]);
      expect(endpoint.origin + endpoint.pathname).toBe('https://webrisk.googleapis.com/v1/uris:search');
      expect(endpoint.searchParams.get('uri')).toBe('https://example.org/');
      expect(endpoint.searchParams.has('key')).toBe(false);
    } finally { await mf.dispose(); }
  });

  it('rejects a redirect and never contacts its destination or the submitted website', async () => {
    const destinations: string[] = [];
    const mf = runtime(async request => {
      destinations.push(request.url);
      return new Response('{}', { status: 302, headers: { Location: 'https://must-not-follow.invalid/' } });
    });
    try {
      const result = await (await mf.dispatchFetch('http://localhost/')).json();
      expect(result).toMatchObject({ reservations: 1, reputation: { state: 'unavailable' } });
      expect(destinations).toHaveLength(1);
      expect(new URL(destinations[0]).origin).toBe('https://webrisk.googleapis.com');
    } finally { await mf.dispose(); }
  });
});
