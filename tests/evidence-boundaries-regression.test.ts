import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInput, Extraction } from '../shared/contracts';
import { collectEvidence, extractUrls } from '../server/evidence';
import { inspectLinkInput } from '../src/linkInput';

const now = new Date('2026-09-27T00:00:00.000Z');
const input = (content: string, overrides: Partial<CheckInput> = {}): CheckInput => ({
  mode: 'link', content, context: '', senderEmail: '', senderPhone: '', externalLookup: true, ...overrides,
});
const options = () => ({
  now, webRiskEnabled: true, webRiskKey: 'offline-test-key',
  reserveLookup: vi.fn(async () => {}),
  fetcher: vi.fn<typeof fetch>().mockImplementation(async () => Response.json({})),
});
const networkGuard = vi.fn(() => { throw new Error('Unexpected real network access in boundary regression.'); });
beforeEach(() => { networkGuard.mockClear(); vi.stubGlobal('fetch', networkGuard); });
afterEach(() => { expect(networkGuard).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('literal userinfo remains unsupported before URL normalization', () => {
  it.each([
    'https://@www.dbs.com.sg/',
    'https://:@www.dbs.com.sg/',
    'https://@@www.dbs.com.sg/',
    'HTTPS://@WWW.DBS.COM.SG/',
    'https://@www.dbs.com.sg',
    '//@www.dbs.com.sg/',
    '@www.dbs.com.sg/',
    'https://%75ser:%70ass@www.dbs.com.sg/',
  ])('does not match, reserve or dispatch %s', async address => {
    const tools = options();
    const result = await collectEvidence(input(address), null, tools);
    expect(result.filter(item => item.kind === 'domain').length).toBeGreaterThan(0);
    expect(result.filter(item => item.kind === 'domain').every(item => item.state === 'unsupported')).toBe(true);
    expect(result.filter(item => item.kind === 'reputation').every(item => item.state === 'unsupported')).toBe(true);
    expect(tools.reserveLookup).not.toHaveBeenCalled();
    expect(tools.fetcher).not.toHaveBeenCalled();
  });

  it('agrees with the existing browser local-only userinfo boundary', async () => {
    const address = 'https://@www.dbs.com.sg/';
    expect(inspectLinkInput(address)).toMatchObject({ kind: 'userinfo', host: 'www.dbs.com.sg' });
    const tools = options();
    const result = await collectEvidence(input(address), null, tools);
    expect(result.find(item => item.kind === 'domain')?.state).toBe('unsupported');
    expect(tools.reserveLookup).not.toHaveBeenCalled();
  });

  it('never includes raw credentials in its explanation', async () => {
    const tools = options();
    const result = await collectEvidence(input('https://synthetic-user:synthetic-secret@www.dbs.com.sg/'), null, tools);
    expect(JSON.stringify(result)).not.toContain('synthetic-user');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(tools.reserveLookup).not.toHaveBeenCalled();
  });
});

describe('malformed authority and empty hostname labels are not repaired into eligible links', () => {
  it.each([
    'https://www.dbs.com.sg../',
    'https://www.dbs.com.sg..',
    'www.dbs.com.sg..',
    'dbs.com.sg..',
    'https://www..dbs.com.sg/',
    'https://.www.dbs.com.sg/',
    'https://www.dbs.com.sg..:443/',
    'https://www.dbs.com.sg%2e%2e/',
    'https://www.dbs.com.sg\u3002\u3002/',
    'https:/@www.dbs.com.sg/',
    'https:////@www.dbs.com.sg/',
    'https:/www.dbs.com.sg/',
    'https:////www.dbs.com.sg/',
  ])('keeps %s unsupported with no lookup reservation', async address => {
    const tools = options();
    const result = await collectEvidence(input(address), null, tools);
    expect(result.some(item => item.kind === 'domain' && item.state === 'unsupported')).toBe(true);
    expect(result.some(item => item.kind === 'domain' && item.state === 'matched')).toBe(false);
    expect(tools.reserveLookup).not.toHaveBeenCalled();
    expect(tools.fetcher).not.toHaveBeenCalled();
  });

  it.each(['https://www.dbs.com.sg..', 'www.dbs.com.sg..', 'dbs.com.sg..'])('extraction preserves malformed authority dots: %s', async address => {
    expect(extractUrls(`Check ${address} now`)).toContain(address);
    const tools = options();
    const result = await collectEvidence(input(`Check ${address} now`, { mode: 'message' }), null, tools);
    expect(result.filter(item => item.kind === 'domain').every(item => item.state === 'unsupported')).toBe(true);
    expect(tools.reserveLookup).not.toHaveBeenCalled();
    expect(tools.fetcher).not.toHaveBeenCalled();
  });

  it('preserves malformed links in screenshot interpretation as unsupported local observations', async () => {
    const tools = options();
    const extraction: Extraction = {
      transcript: 'Visit https://@www.dbs.com.sg/ or https://www.dbs.com.sg..', claimedOrganisation: null,
      urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [],
    };
    const result = await collectEvidence(input('', { mode: 'screenshot' }), extraction, tools);
    expect(result.filter(item => item.kind === 'domain')).toHaveLength(2);
    expect(result.filter(item => item.kind === 'domain').every(item => item.state === 'unsupported')).toBe(true);
    expect(tools.reserveLookup).not.toHaveBeenCalled();
    expect(tools.fetcher).not.toHaveBeenCalled();
  });

  it.each(['https:/www.dbs.com.sg/', 'https:////www.dbs.com.sg/', 'https:www.dbs.com.sg/', 'https:%2f%2fwww.dbs.com.sg/'])('does not extract a repaired host substring from malformed HTTP text: %s', async address => {
    const tools = options();
    const result = await collectEvidence(input(`Visit ${address} to continue.`, { mode: 'message' }), null, tools);
    expect(extractUrls(`Visit ${address} to continue.`)).toEqual([address]);
    expect(result.filter(item => item.kind === 'domain')).toHaveLength(1);
    expect(result.find(item => item.kind === 'domain')?.state).toBe('unsupported');
    expect(tools.reserveLookup).not.toHaveBeenCalled();
    expect(tools.fetcher).not.toHaveBeenCalled();
  });
});

describe('bare userinfo extraction cannot become a username-host lookup', () => {
  const addresses = [
    'example.org:PRIVATE_PASSWORD@www.dbs.com.sg/',
    'example.org:@www.dbs.com.sg/',
    'example.org:443@www.dbs.com.sg/',
    'example.org:private.example.net@www.dbs.com.sg/',
    'example.org:p%40ss@www.dbs.com.sg/',
    'example.org@www.dbs.com.sg/',
  ];
  for (const field of ['message', 'context'] as const) {
    it.each(addresses)(`keeps the whole bare userinfo token local in ${field}: %s`, async address => {
      const text = `Check ${address} now`;
      expect(extractUrls(text)).toEqual([address]);
      const tools = options();
      const value = field === 'message'
        ? input(text, { mode: 'message' })
        : input('A contact asked me to visit an address.', { mode: 'message', context: text });
      const result = await collectEvidence(value, null, tools);
      expect(result.filter(item => item.kind === 'domain')).toHaveLength(1);
      expect(result.find(item => item.kind === 'domain')?.state).toBe('unsupported');
      expect(result.find(item => item.kind === 'reputation')?.state).toBe('unsupported');
      expect(tools.reserveLookup).not.toHaveBeenCalled();
      expect(tools.fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_PASSWORD');
      expect(JSON.stringify(result)).not.toContain('private.example.net');
    });
  }

  it('does not suppress a separate legitimate context URL while excluding bare userinfo', async () => {
    const tools = options();
    const result = await collectEvidence(input('Check example.org:PRIVATE_PASSWORD@www.dbs.com.sg/ now', {
      mode: 'message', context: 'Separately compare https://www.dbs.com.sg/.',
    }), null, tools);
    expect(result.filter(item => item.kind === 'domain').map(item => item.state)).toEqual(['unsupported', 'matched']);
    expect(tools.reserveLookup).toHaveBeenCalledTimes(1);
    expect(tools.fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(tools.fetcher.mock.calls[0][0])).searchParams.get('uri')).toBe('https://www.dbs.com.sg/');
  });
});

describe('valid reference hosts remain distinct from malformed variants', () => {
  it.each(['https://www.dbs.com.sg/', 'https://www.dbs.com.sg./', 'https://www.dbs.com.sg.', 'https://WWW.DBS.COM.SG.:443/'])('preserves the exact reviewed identity of %s', async address => {
    const tools = options();
    const result = await collectEvidence(input(address), null, tools);
    expect(result.filter(item => item.kind === 'domain')).toHaveLength(1);
    expect(result.find(item => item.kind === 'domain')).toMatchObject({ state: 'matched', detail: expect.stringContaining('does not authenticate the sender') });
    expect(tools.reserveLookup).toHaveBeenCalledTimes(1);
    expect(tools.fetcher).toHaveBeenCalledTimes(1);
    expect(result.find(item => item.kind === 'reputation')).toMatchObject({ state: 'no_match', detail: expect.stringContaining('does not establish safety') });
  });

  it.each([
    'https://www.dbs.com.sg/ https://@www.dbs.com.sg/',
    'https://@www.dbs.com.sg/ https://www.dbs.com.sg/',
  ])('does not merge a malformed literal with its normalized valid counterpart: %s', async content => {
    const tools = options();
    const result = await collectEvidence(input(content, { mode: 'message' }), null, tools);
    expect(result.filter(item => item.kind === 'domain').map(item => item.state).sort()).toEqual(['matched', 'unsupported']);
    expect(tools.reserveLookup).toHaveBeenCalledTimes(1);
    expect(tools.fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(tools.fetcher.mock.calls[0][0])).searchParams.get('uri')).toBe('https://www.dbs.com.sg/');
  });

  it.each(['https://www.dbs.com.sg/@reference', 'https://www.dbs.com.sg/?contact=@reference'])('does not confuse @ outside the authority with userinfo: %s', async address => {
    const tools = options();
    const result = await collectEvidence(input(address), null, tools);
    expect(result.find(item => item.kind === 'domain')?.state).toBe('matched');
    expect(result.find(item => item.kind === 'reputation')?.state).toBe('unsupported');
    expect(tools.reserveLookup).not.toHaveBeenCalled();
    expect(tools.fetcher).not.toHaveBeenCalled();
  });

  it('still checks a separately supplied context link without repairing the main input', async () => {
    const tools = options();
    const result = await collectEvidence(input('https:/www.dbs.com.sg/', { context: 'The actual address from my notes is https://www.dbs.com.sg/.' }), null, tools);
    expect(result.filter(item => item.kind === 'domain').map(item => item.state)).toEqual(['unsupported', 'matched']);
    expect(tools.reserveLookup).toHaveBeenCalledTimes(1);
    expect(tools.fetcher).toHaveBeenCalledTimes(1);
  });
});
