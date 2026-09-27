import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { lookupWebRisk } from '../server/web-risk';
import { collectEvidence } from '../server/evidence';
// @ts-expect-error Operator CLI is plain ESM; its dependency-injected paths are exercised offline.
import { main, parseMode, reserveRemoteLookup, runFixedSmoke, googleFailureReason, RESERVATION_SQL, SNAPSHOT_SQL } from '../scripts/check-web-risk.mjs';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const future = '2099-01-01T00:00:00.000Z';
const key = 'synthetic-key-no-account';
const options = (fetcher: typeof fetch) => ({ webRiskKey: key, fetcher, reserveLookup: vi.fn(async () => {}) });

describe('bounded shared Web Risk response handling', () => {
  it.each([
    { name: 'HTTP rejection', status: 403, headers: new Headers() },
    { name: 'advertised oversized body', status: 200, headers: new Headers({ 'content-length': '16385' }) },
  ])('aborts the provider connection after $name', async ({ status, headers }) => {
    let providerSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      providerSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }), { status, headers });
    });
    expect(await lookupWebRisk(new URL('https://example.com/'), options(fetcher))).toMatchObject({ state: 'unavailable' });
    expect(providerSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an oversized streamed body without treating it as no-match', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel,
    })));
    expect(await lookupWebRisk(new URL('https://example.com/'), options(fetcher))).toMatchObject({ state: 'unavailable' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['{', '{"threat":{"threatTypes":["MALWARE"],"expireTime":"not a date"}}', '[]'])('rejects unusable provider data: %s', body => {
    return expect(lookupWebRisk(new URL('https://example.com/'), options(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))))
      .resolves.toMatchObject({ state: 'unavailable' });
  });

  it('does not expose provider body text or credentials on a failure', async () => {
    const result = await lookupWebRisk(new URL('https://example.com/'), options(vi.fn<typeof fetch>()
      .mockResolvedValue(new Response('PRIVATE_PROVIDER_CANARY', { status: 403 }))));
    expect(result.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROVIDER_CANARY|synthetic-key/);
  });
});

describe('operator probe requires deliberate fixed-only execution', () => {
  it('keeps only an allowlisted Google failure reason and excludes private metadata', async () => {
    const response = Response.json({error:{message:'PRIVATE_KEY_CANARY',details:[{
      '@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',
      reason:'API_KEY_SERVICE_BLOCKED',metadata:{consumer:'PRIVATE_PROJECT_CANARY'},
    }]}}, {status:403});
    expect(await googleFailureReason(response)).toBe('API_KEY_SERVICE_BLOCKED');
  });

  it.each(['PRIVATE_KEY_CANARY', 'SERVICE_DISABLED_PRIVATE_CANARY'])('discards unrecognised provider reason %s', async reason => {
    expect(await googleFailureReason(Response.json({error:{details:[{
      '@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason,
    }]}}))).toBe('UNCLASSIFIED');
  });

  it('bounds failure bodies and does not accept lookalike ErrorInfo types', async () => {
    expect(await googleFailureReason(new Response('x'.repeat(16_385)))).toBe('UNCLASSIFIED');
    expect(await googleFailureReason(Response.json({error:{details:[{
      '@type':'other.ErrorInfo',domain:'googleapis.com',reason:'SERVICE_DISABLED',
    }]}}))).toBe('UNCLASSIFIED');
  });

  it('defaults offline and help stays offline', async () => {
    expect(parseMode([])).toBe('offline');
    expect(parseMode(['--help'])).toBe('offline');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
    await main([]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('Offline: no secrets read');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([['--live', '--url', 'https://private.invalid/'], ['--key', key], ['--live', key], ['--live', '--live'], ['https://example.com/']].map(args => ({ args })))('rejects supplied targets/secrets and unknown options before execution', ({ args }) => {
    expect(() => parseMode(args)).toThrow('unsupported_arguments');
  });

  it('reserves before exactly two fixed calls and checks the ordinary origin through product eligibility', async () => {
    const events: Record<string, unknown>[] = [], calls: URL[] = [];
    const reserveLookup = vi.fn(async () => { events.push({ event: 'remote_reserve' }); return reserveLookup.mock.calls.length; });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const endpoint = new URL(String(url)); calls.push(endpoint);
      expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
      expect(new Headers(init?.headers).get('X-Goog-Api-Key')).toBe(key);
      expect(endpoint.searchParams.has('key')).toBe(false);
      return calls.length === 1 ? Response.json({ threat: { threatTypes: ['MALWARE'], expireTime: future } }) : Response.json({});
    });
    const collector = vi.fn(collectEvidence);
    const result = await runFixedSmoke({ key, lookupWebRisk, collectEvidence: collector, reserveLookup, fetcher, record: async (event: Record<string, unknown>) => { events.push(event); } });
    expect(result.passed).toBe(true);
    expect(reserveLookup).toHaveBeenCalledTimes(2);
    expect(collector).toHaveBeenCalledOnce();
    expect(collector.mock.calls[0][0]).toMatchObject({ mode: 'link', content: 'https://example.com/', externalLookup: true });
    expect(calls.map(url => url.origin + url.pathname)).toEqual(Array(2).fill('https://webrisk.googleapis.com/v1/uris:search'));
    expect(calls.map(url => url.searchParams.get('uri'))).toEqual(['http://testsafebrowsing.appspot.com/s/malware.html', 'https://example.com/']);
    for (let i = 0; i < events.length; i++) if (events[i].event === 'provider_dispatch') {
      expect(events.slice(0, i).some(event => event.event === 'reservation_confirmed' && event.fixture === events[i].fixture)).toBe(true);
    }
    expect(JSON.stringify({ events, result })).not.toMatch(/https?:|synthetic-key|threatTypes|expireTime/);
  });

  it('keeps the Google test fixture excluded from normal product lookups', async () => {
    const fetcher = vi.fn<typeof fetch>(), reserveLookup = vi.fn(async () => {});
    const result = await collectEvidence({ mode: 'link', content: 'http://testsafebrowsing.appspot.com/s/malware.html', context: '', senderEmail: '', senderPhone: '', externalLookup: true }, null,
      { webRiskEnabled: true, webRiskKey: key, fetcher, reserveLookup });
    expect(result.find(item => item.kind === 'reputation')?.state).toBe('unsupported');
    expect(fetcher).not.toHaveBeenCalled(); expect(reserveLookup).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500])('does not retry, continue or retain provider text after HTTP %s', async status => {
    const events: unknown[] = [], fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE_PROVIDER_CANARY', { status }));
    const reserveLookup = vi.fn(async () => 1);
    const result = await runFixedSmoke({ key, lookupWebRisk, collectEvidence, reserveLookup, fetcher, record: async (value: unknown) => { events.push(value); } });
    expect(result).toMatchObject({ passed: false, results: [{ state: 'unavailable', code: 'provider_http_failure', requests: 1, httpStatus: status }] });
    expect(fetcher).toHaveBeenCalledOnce(); expect(reserveLookup).toHaveBeenCalledOnce();
    expect(JSON.stringify({ result, events })).not.toMatch(/PRIVATE_PROVIDER_CANARY|synthetic-key|https?:/);
  });

  it('stops without contacting Google when the remote reservation is unconfirmed', async () => {
    const fetcher = vi.fn<typeof fetch>(), reserveLookup = vi.fn(async () => { throw new Error('PRIVATE_CONTROL_PLANE_CANARY'); });
    const result = await runFixedSmoke({ key, lookupWebRisk, collectEvidence, reserveLookup, fetcher });
    expect(result).toMatchObject({ passed: false, results: [{ state: 'not_dispatched', code: 'remote_reservation_unconfirmed', requests: 0 }] });
    expect(fetcher).not.toHaveBeenCalled(); expect(reserveLookup).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONTROL_PLANE_CANARY');
  });
});

describe('remote lookup reservation SQL and failure boundary', () => {
  function remote(count = 0, halted = 0) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE budget (id INTEGER PRIMARY KEY, lookup_count INTEGER, halted INTEGER);');
    sqlite.prepare('INSERT INTO budget VALUES(1,?,?)').run(count, halted);
    const execute = vi.fn(async (_binary: string, args: string[], options: { env: Record<string, string> }) => {
      expect(args).toContain('--remote'); expect(args).not.toContain('--local');
      expect(options.env).not.toHaveProperty('GOOGLE_WEB_RISK_API_KEY');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options.env).not.toHaveProperty('WRANGLER_LOG');
      const sql = args[args.indexOf('--command') + 1];
      const results = sqlite.prepare(sql).all();
      const changes = sql === SNAPSHOT_SQL ? 0 : Number(sqlite.prepare('SELECT changes() AS changes').get()!.changes);
      return { stdout: JSON.stringify([{ success: true, results, meta: { changes } }]) };
    });
    return { sqlite, execute, count: () => sqlite.prepare('SELECT lookup_count FROM budget').get()!.lookup_count };
  }

  it('reserves the final available slot atomically without modifying AI counters', async () => {
    const test = remote(999);
    try { expect(await reserveRemoteLookup({ execute: test.execute })).toBe(1000); expect(test.count()).toBe(1000); expect(test.execute).toHaveBeenCalledTimes(2); }
    finally { test.sqlite.close(); }
  });

  it.each([[1000, 0], [10, 1], [-1, 0], [1.5, 0]])('refuses exhausted, halted or malformed state %s/%s without an UPDATE', async (count, halted) => {
    const test = remote(count, halted);
    try { await expect(reserveRemoteLookup({ execute: test.execute })).rejects.toThrow('remote_reservation_unconfirmed'); expect(test.count()).toBe(count); expect(test.execute).toHaveBeenCalledOnce(); }
    finally { test.sqlite.close(); }
  });

  it('a repeated conditional write cannot consume a second lookup', () => {
    const test = remote(41);
    try {
      const sql = RESERVATION_SQL.replace(':previous_count', '41');
      expect(test.sqlite.prepare(sql).all()).toEqual([{ lookup_count: 42 }]);
      expect(test.sqlite.prepare(sql).all()).toEqual([]);
      expect(test.count()).toBe(42);
    } finally { test.sqlite.close(); }
  });

  it.each(['not-json', '[]', '{"secret":"PRIVATE_CANARY"}'])('does not retry or expose unconfirmed control-plane output', async stdout => {
    const execute = vi.fn(async () => ({ stdout }));
    await expect(reserveRemoteLookup({ execute })).rejects.toThrow('remote_reservation_unconfirmed');
    expect(execute).toHaveBeenCalledOnce();
  });
});
