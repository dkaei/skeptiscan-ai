import { describe, expect, it, vi, afterEach } from 'vitest';
import type { CheckInput, Extraction } from '../shared/contracts';
import { collectEvidence, extractUrls, type EvidenceOptions } from '../server/evidence';
import { GUIDANCE, isCurrentSource, selectGuidance } from '../server/guidance';

const now = new Date('2026-09-26T12:00:00.000Z');
const input = (content: string, overrides: Partial<CheckInput> = {}): CheckInput => ({
  mode: 'message', content, context: '', senderEmail: '', senderPhone: '', externalLookup: false, ...overrides,
});
const extraction = (overrides: Partial<Extraction> = {}): Extraction => ({
  transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [], ...overrides,
});
const live = (body: unknown = {}): EvidenceOptions & { fetcher: ReturnType<typeof vi.fn<typeof fetch>>; reserveLookup: ReturnType<typeof vi.fn<() => Promise<void>>> } => ({
  now, webRiskEnabled: true, webRiskKey: 'test-key', reserveLookup: vi.fn(async () => {}),
  fetcher: vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })),
});
afterEach(() => vi.useRealTimers());

describe('URL extraction and local identity evidence', () => {
  it('extracts bare and full URLs without extracting email addresses or enclosing punctuation', () => {
    expect(extractUrls('Write a@dbs.com.sg. See (https://dbs.com.sg/) and singpost.com; https://dbs.com.sg/')).toEqual(['https://dbs.com.sg/', 'singpost.com']);
  });
  it('retains balanced path parentheses instead of changing the submitted URL', () => {
    expect(extractUrls('(https://example.org/a(b))')).toEqual(['https://example.org/a(b)']);
  });
  it('matches only a reviewed exact host, with explicit sender/action limits', async () => {
    const result = await collectEvidence(input('See https://www.dbs.com.sg/'), null, { now });
    expect(result.find(e => e.kind === 'domain')).toMatchObject({ state: 'matched', sourceUrl: expect.stringContaining('dbs.com.sg') });
    expect(result.find(e => e.kind === 'domain')?.detail).toContain('does not authenticate the sender');
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('not_checked');
  });
  it('identifies a reviewed domain embedded in an unrelated hostname', async () => {
    const result = await collectEvidence(input('DBS: https://dbs.com.sg.evil.com'), null, { now });
    const domain = result.find(e => e.kind === 'domain');
    expect(domain).toMatchObject({ state: 'observation' });
    expect(domain?.detail).toContain('Registrable domain: evil.com');
    expect(domain?.detail).toContain('not an exact');
  });
  it('does not trust unlisted subdomains or turn absent coverage into fraud', async () => {
    const result = await collectEvidence(input('DBS https://payments.dbs.com.sg/'), null, { now });
    expect(result.find(e => e.kind === 'domain')).toMatchObject({ state: 'no_match' });
    expect(result.find(e => e.kind === 'domain')?.detail).toContain('Unlisted services may be legitimate');
  });
  it('does not assert a current official-host match after the source review expires', async () => {
    const result = await collectEvidence(input('https://dbs.com.sg'), null, { now: new Date('2026-11-01') });
    expect(result.find(e => e.kind === 'domain')?.state).toBe('unavailable');
    expect(result.find(e => e.kind === 'domain')?.detail).not.toContain('Exact host match');
  });
  it.each([
    'https://dbs.com.sg@evil.com/', 'https://user:secret@dbs.com.sg/',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/',
    'http://169.254.169.254/', 'https://localhost/', 'https://metadata.google.internal/',
    'https://parcel.example/', 'ftp://dbs.com.sg/', 'https://dbs.com.sg:8443/',
    'https://dЬs.com.sg/', 'https://xn--bcher-kva.de/', 'https://bad\\host.com/',
  ])('does not fetch unsupported URL %s', async value => {
    const options = live();
    const result = await collectEvidence(input(value, { mode: 'link', externalLookup: true }), null, options);
    expect(result.some(e => e.kind === 'domain' && e.state === 'unsupported')).toBe(true);
    expect(options.fetcher).not.toHaveBeenCalled();
    expect(options.reserveLookup).not.toHaveBeenCalled();
    expect(result.some(e => e.kind === 'domain' && e.state === 'matched')).toBe(false);
  });
  it('does not let ungrounded model URLs, transcript or claimed identity trigger checks', async () => {
    const options = live();
    const result = await collectEvidence(input('Hello there', { externalLookup: true }), extraction({
      urls: ['https://dbs.com.sg'], transcript: 'https://dbs.com.sg', claimedOrganisation: 'DBS',
    }), options);
    expect(options.fetcher).not.toHaveBeenCalled();
    expect(result.some(e => e.kind === 'domain')).toBe(false);
  });
});

describe('external lookup boundaries and actual tool states', () => {
  it.each([
    'https://example.org/reset/secretToken', 'https://example.org/login',
    'https://example.org/?token=secret', 'https://example.org/#private',
    'https://example.org/%73ecret', 'https://privateaccount.example.org/',
    'https://myuser.github.io/',
  ])('keeps private or potentially token-bearing URL local: %s', async value => {
    const options = live();
    const result = await collectEvidence(input(value, { mode: 'link', externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unsupported');
    expect(options.fetcher).not.toHaveBeenCalled();
    expect(options.reserveLookup).not.toHaveBeenCalled();
  });
  it('requires explicit external consent', async () => {
    const options = live();
    const result = await collectEvidence(input('https://example.org'), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('not_checked');
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it('requires a persistent reservation callback even with key, feature flag and consent', async () => {
    const options = { ...live(), reserveLookup: undefined };
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unavailable');
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it('never sends an image-extracted link externally', async () => {
    const options = live();
    const result = await collectEvidence(input('', { mode: 'screenshot', externalLookup: true }), extraction({ transcript: 'https://example.org' }), options);
    expect(result.some(e => e.kind === 'domain')).toBe(true);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unsupported');
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it('reserves before fetching only the fixed Google endpoint, with redirects disabled', async () => {
    const options = live();
    const order: string[] = [];
    options.reserveLookup.mockImplementation(async () => { order.push('reserve'); });
    options.fetcher.mockImplementation(async (url, init) => {
      order.push('fetch');
      const endpoint = new URL(String(url));
      expect(endpoint.origin + endpoint.pathname).toBe('https://webrisk.googleapis.com/v1/uris:search');
      expect(endpoint.searchParams.get('uri')).toBe('https://example.org/');
      expect(endpoint.searchParams.getAll('threatTypes')).toEqual(['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE']);
      expect(endpoint.searchParams.has('key')).toBe(false);
      expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', headers: { 'X-Goog-Api-Key': 'test-key' } });
      return new Response('{}');
    });
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(order).toEqual(['reserve', 'fetch']);
    expect(result.find(e => e.kind === 'reputation')).toMatchObject({ state: 'no_match', detail: expect.stringContaining('does not establish safety') });
  });
  it('does not dispatch when the global lookup allowance cannot be reserved', async () => {
    const options = live();
    options.reserveLookup.mockRejectedValue(new Error('quota exhausted'));
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unavailable');
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it('caps external requests at three and marks additional URLs as not checked', async () => {
    const options = live();
    const result = await collectEvidence(input('https://example.org https://example.com https://iana.org https://ietf.org', { externalLookup: true }), null, options);
    expect(options.fetcher).toHaveBeenCalledTimes(3);
    expect(options.reserveLookup).toHaveBeenCalledTimes(3);
    expect(result.find(e => e.id === 'reputation-3')?.state).toBe('not_checked');
  });
  it('reports an actual fresh provider match with attribution and uncertainty', async () => {
    const options = live({ threat: { threatTypes: ['SOCIAL_ENGINEERING'], expireTime: '2026-09-27T00:00:00Z' } });
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')).toMatchObject({ state: 'matched', title: 'Google Web Risk lookup', detail: expect.stringContaining('can miss risky sites or flag safe sites') });
  });
  it.each([
    null, [], { error: 'unknown' }, { threat: null },
    { threat: { threatTypes: ['SAFE'], expireTime: '2026-09-27T00:00:00Z' } },
    { threat: { threatTypes: [], expireTime: '2026-09-27T00:00:00Z' } },
    { threat: { threatTypes: ['MALWARE'], expireTime: '2026-09-25T00:00:00Z' } },
  ])('does not turn invalid/expired provider data into a no-match: %j', async body => {
    const options = live(body);
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unavailable');
    expect(options.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([302, 403, 429, 500])('does not retry provider status %s', async status => {
    const options = live();
    options.fetcher.mockResolvedValue(new Response('', { status }));
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unavailable');
    expect(options.fetcher).toHaveBeenCalledTimes(1);
  });
  it('enforces a five-second deadline even if the fetch implementation never settles', async () => {
    vi.useFakeTimers();
    const options = live();
    options.fetcher.mockImplementation(() => new Promise(() => {}));
    const resultPromise = collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await resultPromise;
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unavailable');
    expect(options.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('does not reserve or fetch after caller cancellation', async () => {
    const options = { ...live(), signal: AbortSignal.abort() };
    const result = await collectEvidence(input('https://example.org', { externalLookup: true }), null, options);
    expect(result.find(e => e.kind === 'reputation')?.state).toBe('unavailable');
    expect(options.fetcher).not.toHaveBeenCalled();
    expect(options.reserveLookup).not.toHaveBeenCalled();
  });
});

describe('phone information and reviewed guidance', () => {
  it('normalises a supplied Singapore number but never invents a report history', async () => {
    const result = await collectEvidence(input('They asked me to pay.', { mode: 'call', senderPhone: '8123 4567' }), null, { now });
    expect(result.find(e => e.kind === 'phone')).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('+6581234567') });
    expect(result.find(e => e.kind === 'phone')?.detail).toContain('No authorised reported-number feed');
  });
  it('keeps masked numbers unsupported rather than interpreting them as verified', async () => {
    const result = await collectEvidence(input('Unexpected call', { mode: 'call', senderPhone: '+65 8*** 4567' }), null, { now });
    expect(result.find(e => e.kind === 'phone')?.state).toBe('unsupported');
  });
  it('selects at most three relevant, sourced, bounded guidance excerpts', () => {
    const result = selectGuidance('Send your banking password. A courier says pay a delivery fee. Install this remote-access app. Open the government website https://www.gov.sg/.', now);
    expect(result).toHaveLength(3);
    for (const item of result) {
      expect(item.state).toBe('observation');
      expect(item.sourceUrl).toMatch(/^https:\/\/(?:www\.)?(?:police\.gov\.sg|dbs\.com\.sg|gov\.sg)\//);
      expect(item.detail.length).toBeLessThan(650);
      expect(item.detail).toContain('not proof');
    }
  });
  it('does not supply stale source advice to the reviewer', () => {
    const result = selectGuidance('Please send your banking password', new Date('2026-10-27'));
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('unavailable');
    expect(result[0].detail).not.toContain(GUIDANCE[0].excerpt);
  });
  it('treats dates before review and at expiry as outside the review window', () => {
    expect(isCurrentSource(GUIDANCE[0], new Date('2026-09-25'))).toBe(false);
    expect(isCurrentSource(GUIDANCE[0], new Date(GUIDANCE[0].expiresAt))).toBe(false);
  });
  it('does not promote an action interpretation into a source fact even when its quote is literal', async () => {
    const result = await collectEvidence(input('Tell me the six digits'), extraction({ requestedActions: [{ action: 'share account verification code', quote: 'Tell me the six digits' }] }), { now });
    expect(result.some(e => e.kind === 'guidance')).toBe(false);
    const invented = await collectEvidence(input('Hello'), extraction({ requestedActions: [{ action: 'share banking password', quote: 'Give me the password' }] }), { now });
    expect(invented.some(e => e.kind === 'guidance')).toBe(false);
  });
});
