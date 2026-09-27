import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInput, Evidence, Extraction } from '../shared/contracts';
import { collectEvidence } from '../server/evidence';
import { selectGuidance } from '../server/guidance';
import { inspectLinkInput } from '../src/linkInput';

// Frozen adversarial expectations. These are offline capability/regression
// checks, not empirical scam labels or claims about the example domains.
const now = new Date('2026-09-27T00:00:00.000Z');
const input = (content: string, overrides: Partial<CheckInput> = {}): CheckInput => ({
  mode: 'link', content, context: '', senderEmail: '', senderPhone: '', externalLookup: false, ...overrides,
});
const extracted = (overrides: Partial<Extraction> = {}): Extraction => ({
  transcript: '', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [],
  unreadableDetails: [], missingContext: [], ...overrides,
});
const byKind = (items: Evidence[], kind: Evidence['kind']) => items.filter(item => item.kind === kind);
const guidanceIds = (text: string) => selectGuidance(text, now).map(item => item.id.replace('guidance-', '')).sort();

const forbiddenNetwork = vi.fn<typeof fetch>(async () => { throw new Error('OFFLINE_STRESS_NETWORK_FORBIDDEN'); });
beforeEach(() => { forbiddenNetwork.mockClear(); vi.stubGlobal('fetch', forbiddenNetwork); });
afterEach(() => { expect(forbiddenNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

function guardedOptions() {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('OFFLINE_INJECTED_FETCH_CALLED'); });
  const reserveLookup = vi.fn(async () => {});
  return { now, webRiskKey: 'synthetic-test-key-not-a-credential', webRiskEnabled: true, fetcher, reserveLookup };
}

describe('stress: literal host identity and privacy', () => {
  it.each([
    ['D01 embedded reviewed host', 'https://www.dbs.com.sg.accounts.example.org/', 'www.dbs.com.sg.accounts.example.org'],
    ['D02 reviewed host in query', 'https://example.org/?continue=https://www.dbs.com.sg/', 'example.org'],
    ['D03 reviewed host in fragment', 'https://example.org/#https://www.dbs.com.sg/', 'example.org'],
    ['D04 reviewed host in path', 'https://example.org/www.dbs.com.sg/', 'example.org'],
    ['D05 percent-encoded host separator', 'https://www.dbs.com.sg%2eexample.org/', 'www.dbs.com.sg.example.org'],
    ['D06 Unicode full-stop separator', 'https://dbs.com.sg\u3002example.org/', 'dbs.com.sg.example.org'],
  ])('%s never transfers the organisation match to another host', async (_label, value, host) => {
    const options = guardedOptions();
    const result = await collectEvidence(input(value, { externalLookup: true }), null, options);
    const domains = byKind(result, 'domain');
    expect(domains).toHaveLength(1);
    expect(domains[0].detail).toContain(`Actual host: ${host}.`);
    expect(domains[0].state).not.toBe('matched');
    expect(byKind(result, 'reputation').every(item => item.state === 'unsupported')).toBe(true);
    expect(options.fetcher).not.toHaveBeenCalled();
    expect(options.reserveLookup).not.toHaveBeenCalled();
  });

  it.each([
    ['D07 exact host with trailing dot', 'https://www.dbs.com.sg./'],
    ['D08 mixed-case exact host', 'https://WWW.DBS.COM.SG/'],
    ['D09 standard HTTPS port', 'https://www.dbs.com.sg:443/'],
  ])('%s preserves DNS identity without authenticating the sender', async (_label, value) => {
    const options = guardedOptions();
    const result = await collectEvidence(input(value), null, options);
    expect(byKind(result, 'domain')[0]).toMatchObject({ state: 'matched' });
    expect(byKind(result, 'domain')[0].detail).toContain('does not authenticate the sender');
    expect(byKind(result, 'reputation')[0].state).toBe('not_checked');
    expect(options.fetcher).not.toHaveBeenCalled();
  });

  it('D10 percent-encoded canonical host can match locally but is never sent externally', async () => {
    const options = guardedOptions();
    const result = await collectEvidence(input('https://%77%77%77.dbs.com.sg/', { externalLookup: true }), null, options);
    expect(byKind(result, 'domain')[0].detail).toContain('Actual host: www.dbs.com.sg.');
    expect(byKind(result, 'reputation')[0].state).toBe('unsupported');
    expect(options.fetcher).not.toHaveBeenCalled();
    expect(options.reserveLookup).not.toHaveBeenCalled();
  });

  it('D11 genuine source host does not verify a query-supplied redirect destination', async () => {
    const options = guardedOptions();
    const result = await collectEvidence(input('https://www.dbs.com.sg/?next=https://unverified.example.org/', { externalLookup: true }), null, options);
    expect(byKind(result, 'domain')).toHaveLength(1);
    expect(byKind(result, 'domain')[0]).toMatchObject({ state: 'matched' });
    expect(byKind(result, 'domain')[0].detail).toContain('verify a redirect destination');
    expect(byKind(result, 'reputation')[0].state).toBe('unsupported');
    expect(options.fetcher).not.toHaveBeenCalled();
  });

  it('D12 an organisation claim does not override the unrelated literal host', async () => {
    const options = guardedOptions();
    const result = await collectEvidence(input('DBS says use https://example.org/', { mode: 'message' }), extracted({ claimedOrganisation: 'DBS' }), options);
    expect(byKind(result, 'domain')[0]).toMatchObject({ state: 'no_match' });
    expect(byKind(result, 'domain')[0].detail).toContain('not one of its exact hosts');
    expect(byKind(result, 'domain')[0].detail).toContain('missing coverage does not establish fraud or safety');
    expect(options.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['D13 Cyrillic hostname', 'https://d\u042cs.com.sg/'],
    ['D14 explicit punycode hostname', 'https://xn--e1afmkfd.xn--p1ai/'],
    ['D15 username before real host', 'https://www.dbs.com.sg@accounts.example.org/'],
    ['D16 embedded password', 'https://synthetic-user:SYNTHETIC_PRIVATE_VALUE@www.dbs.com.sg/'],
    ['D17 encoded at-sign in host', 'https://www.dbs.com.sg%40example.org/'],
    ['D18 loopback IPv4', 'https://127.0.0.1/'],
    ['D19 shortened IPv4', 'https://127.1/'],
    ['D20 numeric IPv4', 'https://2130706433/'],
    ['D21 hexadecimal IPv4', 'https://0x7f000001/'],
    ['D22 IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/'],
    ['D23 private suffix', 'https://www.dbs.com.sg.internal/'],
    ['D24 unsupported port', 'https://www.dbs.com.sg:8443/'],
    ['D25 double trailing dot', 'https://www.dbs.com.sg../'],
  ])('%s remains unsupported without a lookup or directory endorsement', async (_label, value) => {
    const options = guardedOptions();
    const result = await collectEvidence(input(value, { externalLookup: true }), null, options);
    expect.soft(byKind(result, 'domain')).not.toHaveLength(0);
    expect.soft(byKind(result, 'domain').map(item => item.state), `Observed domain evidence: ${JSON.stringify(byKind(result, 'domain'))}`).toEqual(byKind(result, 'domain').map(() => 'unsupported'));
    expect.soft(byKind(result, 'reputation').map(item => item.state)).toEqual(byKind(result, 'reputation').map(() => 'unsupported'));
    expect.soft(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
    expect.soft(options.fetcher).not.toHaveBeenCalled();
    expect.soft(options.reserveLookup).not.toHaveBeenCalled();
  });

  it('D26 empty userinfo is handled consistently by browser and server boundaries', async () => {
    const value = 'https://@www.dbs.com.sg/';
    expect(inspectLinkInput(value).kind).toBe('userinfo');
    const options = guardedOptions();
    const result = await collectEvidence(input(value, { externalLookup: true }), null, options);
    expect.soft(byKind(result, 'domain').map(item => item.state), `Observed domain evidence: ${JSON.stringify(byKind(result, 'domain'))}`).toEqual(['unsupported']);
    expect.soft(byKind(result, 'reputation').map(item => item.state)).toEqual(['unsupported']);
    expect.soft(options.reserveLookup).not.toHaveBeenCalled();
    expect.soft(options.fetcher).not.toHaveBeenCalled();
  });

  it('D27 simulated provider outage remains unavailable, never no-match', async () => {
    const options = guardedOptions();
    const result = await collectEvidence(input('https://example.org/', { externalLookup: true }), null, options);
    expect(options.fetcher).toHaveBeenCalledTimes(1);
    expect(options.reserveLookup).toHaveBeenCalledTimes(1);
    expect(byKind(result, 'reputation')[0].state).toBe('unavailable');
    expect(byKind(result, 'reputation')[0].detail).toContain('No result or safety conclusion');
  });

  it('D28 non-HTTP browser input is rejected without executing its contents', async () => {
    const value = 'javascript:alert("SYNTHETIC_DO_NOT_EXECUTE")';
    expect(inspectLinkInput(value).kind).toBe('invalid');
    const result = await collectEvidence(input(value), null, { now });
    expect(byKind(result, 'domain')[0].state).toBe('unsupported');
  });

  it('D29 Unicode lookalike can be typed but the evidence layer withholds a directory match', async () => {
    const value = 'https://d\u042cs.com.sg/';
    expect(inspectLinkInput(value).kind).toBe('website');
    const result = await collectEvidence(input(value), null, { now });
    expect(byKind(result, 'domain')[0].state).toBe('unsupported');
  });

  it('D30 a seventh requested URL is omitted only with an explicit coverage notice', async () => {
    const background = ['https://example.org/', 'https://example.com/', 'https://example.net/', 'https://iana.org/', 'https://ietf.org/', 'https://w3.org/'];
    const requested = 'https://www.dbs.com.sg.accounts.example.org/';
    const content = `Background links: ${background.join(' ')}. The caller wants me to enter my bank login code at ${requested}`;
    const result = await collectEvidence(input(content, { mode: 'message' }), null, { now });
    expect(byKind(result, 'domain')).toHaveLength(6);
    expect(byKind(result, 'domain').some(item => item.detail.includes('Actual host: www.dbs.com.sg.accounts.example.org.'))).toBe(false);
    expect(byKind(result, 'input').some(item => item.state === 'not_checked' && /additional links|links were not checked/i.test(item.title))).toBe(true);
    expect(byKind(result, 'domain').some(item => item.state === 'matched')).toBe(false);
  });

  it('D31 equivalent background URL spellings can consume the bound but cannot hide the coverage notice', async () => {
    const background = ['https://example.org/', 'https://EXAMPLE.ORG/', 'https://example.org:443/', 'https://eXample.org/', 'https://Example.org/', 'https://example.org'];
    const content = `${background.join(' ')} Please use https://www.dbs.com.sg.accounts.example.org/ to finish the payment.`;
    const result = await collectEvidence(input(content, { mode: 'message' }), null, { now });
    expect(byKind(result, 'domain')).toHaveLength(1);
    expect(byKind(result, 'domain')[0].detail).toContain('Actual host: example.org.');
    expect(byKind(result, 'input').some(item => item.state === 'not_checked' && /additional links|links were not checked/i.test(item.title))).toBe(true);
    expect(byKind(result, 'domain').some(item => item.state === 'matched')).toBe(false);
  });
});

describe('stress: phone information never creates caller evidence', () => {
  it.each([
    ['P01 masked Singapore number', '+65 8*** 4567'],
    ['P02 incomplete number', '+65 8123'],
    ['P03 number with unparsed explanatory text', 'DBS 8123 4567'],
    ['P04 unavailable text', 'number unavailable'],
  ])('%s is not completed or assigned a report history', async (_label, senderPhone) => {
    const result = await collectEvidence(input('I missed a call.', { mode: 'call', senderPhone }), extracted({ phoneNumbers: ['+6581234567'] }), { now });
    expect(byKind(result, 'phone')).toHaveLength(1);
    expect(byKind(result, 'phone')[0].state).toBe('unsupported');
    expect(byKind(result, 'phone')[0].detail).not.toContain('+6581234567');
  });

  it('P05 a model-supplied complete number does not repair absent user evidence', async () => {
    const result = await collectEvidence(input('The caller did not speak.', { mode: 'call' }), extracted({ phoneNumbers: ['+6581234567'], transcript: '+65 8123 4567', claimedOrganisation: 'DBS' }), { now });
    expect(byKind(result, 'phone')[0]).toMatchObject({ state: 'unavailable' });
    expect(byKind(result, 'phone')[0].detail).toContain('No complete number');
    expect(JSON.stringify(result)).not.toContain('+6581234567');
  });

  it('P06 a normalisable number is format information, never a verified caller or no-report result', async () => {
    const result = await collectEvidence(input('They claim to be DBS.', { mode: 'call', senderPhone: '8123 4567' }), null, { now });
    const phone = byKind(result, 'phone')[0];
    expect(phone.state).toBe('unavailable');
    expect(phone.detail).toContain('+6581234567');
    expect(phone.detail).toContain('format information only');
    expect(phone.detail).toContain('identity and report history were not verified');
  });

  it('P07 a six-digit code is not silently promoted into a caller number', async () => {
    const result = await collectEvidence(input('The caller asked me to read 123456.', { mode: 'call' }), null, { now });
    expect(byKind(result, 'phone')).toHaveLength(1);
    expect(byKind(result, 'phone')[0].detail).toContain('No complete number');
  });
});

describe('stress: mixed requests and negation preserve reference scope', () => {
  it.each<[string, string, string[]]>([
    ['G01 negative disclosure plus positive token approval', 'I was not asked to provide a password, but I was told to approve the Digital Token request.', ['account-credentials']],
    ['G02 declined installation plus positive WhatsApp disclosure', 'I am not installing AnyDesk. However, this caller asks me to forward the WhatsApp registration code.', ['whatsapp-account']],
    ['G03 absent remote request plus positive delivery payment', 'No remote access was requested. A caller now asks me to transfer S$2 for my parcel delivery.', ['parcel-payment']],
    ['G04 safe credential advice plus positive remote installation', 'The caller says do not share a password. Instead, install AnyDesk and allow remote access.', ['remote-access']],
    ['G05 QR request with preceding delivery context', 'The courier said the delivery is free. They then asked me to scan this QR code to get my refund.', ['parcel-payment']],
    ['G06 background government topic plus unrelated delivery request', 'The government article is only background. Separately, a courier now asks me to pay S$2 to release a parcel.', ['parcel-payment']],
    ['G07 negative fee clause plus positive bank-code request', 'There is no parcel fee to pay; just read your bank login OTP to this caller.', ['account-credentials']],
    ['G08 mixed present-tense negation and affirmative request', 'No one wants my password. They do want me to send my account code.', ['account-credentials']],
    ['G09 explicit refusal alone', 'I refuse to share my bank login code.', []],
    ['G10 progressive negative installation request', 'No one is asking me to install or allow remote access. I chose to update my calendar myself.', []],
    ['G11 coordinated negative payment and link request', 'The courier says do not pay a delivery fee or click a payment link.', []],
    ['G12 passive bank-code disclosure after harmless reassurance', 'The text says no password is needed; your bank login code must be sent to the agent.', ['account-credentials']],
    ['G13 passive fee demand after harmless credential advice', 'Do not send a password; the courier says the S$2 redelivery fee must be paid now.', ['parcel-payment']],
    ['G14 declined fee request and refusal to pay', 'The courier did not ask for payment and I will not pay a redelivery fee.', []],
    ['G15 mixed request carries two applicable references', 'Never send a banking password. A courier now asks me to pay S$2 for delivery and then install AnyDesk for remote access.', ['parcel-payment', 'remote-access']],
    ['G16 unrelated ordinary PIN is not banking authentication', 'The library asks me to read the shelf location code from my collection slip. No account login is involved.', []],
  ])('%s', async (_label, text, expected) => {
    // Exercise both retrieval directly and the actual evidence integration.
    expect.soft(guidanceIds(text), `Selected reference IDs: ${JSON.stringify(guidanceIds(text))}`).toEqual([...expected].sort());
    const result = await collectEvidence(input(text, { mode: 'message' }), null, { now });
    expect.soft(byKind(result, 'guidance').map(item => item.id.replace('guidance-', '')).sort()).toEqual([...expected].sort());
    for (const item of byKind(result, 'guidance')) {
      expect(item.state).toBe('observation');
      expect(item.sourceUrl).toMatch(/^https:\/\/(?:www\.)?(?:police\.gov\.sg|dbs\.com\.sg|gov\.sg)\//);
      expect(item.detail).toContain('reference guidance, not proof');
    }
  });
});
