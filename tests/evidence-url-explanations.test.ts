import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInput, Evidence, Extraction } from '../shared/contracts';
import { collectEvidence } from '../server/evidence';

const now = new Date('2026-09-27T12:00:00Z');
const input = (content: string, overrides: Partial<CheckInput> = {}): CheckInput => ({
  mode: 'link', content, context: '', senderEmail: '', senderPhone: '', externalLookup: true, ...overrides,
});
const domain = (items: Evidence[]) => items.find(item => item.kind === 'domain')!;
const reputation = (items: Evidence[]) => items.find(item => item.kind === 'reputation')!;
const options = () => ({
  now, webRiskEnabled: true, webRiskKey: 'offline-test-key',
  reserveLookup: vi.fn(async () => {}),
  fetcher: vi.fn<typeof fetch>(async () => Response.json({})),
});
const forbiddenNetwork = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected real network access'); });
beforeEach(() => { forbiddenNetwork.mockClear(); vi.stubGlobal('fetch', forbiddenNetwork); });
afterEach(() => { expect(forbiddenNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('deterministic URL component explanations', () => {
  it.each([
    ['checkout.meridian-pay.example', 'accounts.harbour-bank.example'],
    ['accounts.harbour-bank.example', 'checkout.meridian-pay.example'],
  ])('follows the literal host/query roles when %s points to query text %s', async (host, queryHost) => {
    const tool = options();
    const result = await collectEvidence(input(`https://${host}/?continue=https://${queryHost}/`), null, tool);
    expect(domain(result)).toMatchObject({ state: 'unsupported' });
    expect(domain(result).detail).toContain(`Actual host: ${host}.`);
    expect(domain(result).detail).toContain(`query contains hostname text (${queryHost})`);
    expect(domain(result).detail).toContain('query text does not change the actual host');
    expect(domain(result).detail).toContain('not proof that a redirect occurs');
    expect(domain(result).detail).toContain('does not open the link or follow redirects');
    expect(domain(result).detail).toContain('no final destination or website owner has been verified');
    expect(reputation(result).state).toBe('unsupported');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['https://example.org/www.dbs.com.sg/login', 'path', 'www.dbs.com.sg'],
    ['https://example.org/?next=https://www.dbs.com.sg/private-path', 'query', 'www.dbs.com.sg'],
    ['https://example.org/?return_url=https%3A%2F%2Fwww.dbs.com.sg%2Fprivate-path', 'query', 'www.dbs.com.sg'],
  ])('does not transfer identity from a name elsewhere in %s', async (address, component, embeddedHost) => {
    const tool = options();
    const result = await collectEvidence(input(address), null, tool);
    expect(domain(result).state).toBe('no_match');
    expect(domain(result).detail).toContain('Actual host: example.org.');
    expect(domain(result).detail).toContain(`${component} contains hostname text (${embeddedHost})`);
    expect(domain(result).detail).not.toContain('private-path');
    expect(domain(result).detail).toContain('missing coverage does not establish fraud or safety');
    expect(reputation(result).state).toBe('unsupported');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });

  it('does not claim a hostname occurs only in the query when it is repeated there', async () => {
    const result = await collectEvidence(input('https://www.dbs.com.sg/?next=https://www.dbs.com.sg/'), null, options());
    expect(domain(result).state).toBe('matched');
    expect(domain(result).detail).toContain('Actual host: www.dbs.com.sg.');
    expect(domain(result).detail).toContain('query contains hostname text (www.dbs.com.sg)');
    expect(domain(result).detail).not.toMatch(/only in (?:the )?query|not (?:the |this link.s )?hostname/i);
    expect(domain(result).detail).toContain('does not authenticate the sender');
  });

  it('explains fragment placement without repeating fragment contents', async () => {
    const result = await collectEvidence(input('https://example.org/#https://www.dbs.com.sg/PRIVATE_FRAGMENT'), null, options());
    expect(domain(result).state).toBe('no_match');
    expect(domain(result).detail).toContain('Fragment text after # does not change the actual host');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FRAGMENT');
    expect(reputation(result).state).toBe('unsupported');
  });

  it('keeps query secrets and nested credentials out of evidence prose', async () => {
    const result = await collectEvidence(input('https://example.org/?token=SECRET_TOKEN&password=private-password.example&next=https://PRIVATE_USER:PRIVATE_SECRET@target.example/private'), null, options());
    const text = JSON.stringify(result);
    for (const secret of ['SECRET_TOKEN', 'private-password.example', 'PRIVATE_USER', 'PRIVATE_SECRET']) expect(text).not.toContain(secret);
    expect(domain(result).detail).toContain('Query text after ? does not change the actual host');
    expect(domain(result).detail).toContain('not proof that a redirect occurs');
  });

  it.each(['https://www.dbs.com.sg@accounts.example.org/', 'https://@accounts.example.org/'])('explains user information without treating it as a destination: %s', async address => {
    const tool = options();
    const result = await collectEvidence(input(address), null, tool);
    expect(domain(result).state).toBe('unsupported');
    expect(domain(result).detail).toContain('Actual host: accounts.example.org.');
    expect(domain(result).detail).toContain('Text before @ is user information, not the destination hostname');
    expect(reputation(result).state).toBe('unsupported');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });

  it('does not print top-level username/password contents while explaining the boundary', async () => {
    const result = await collectEvidence(input('https://PRIVATE_USER:PRIVATE_PASSWORD@www.dbs.com.sg/'), null, options());
    expect(domain(result).detail).toContain('Text before @ is user information');
    expect(domain(result).state).toBe('unsupported');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_USER');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PASSWORD');
  });
});

describe('international hostname limits without invented lookalike conclusions', () => {
  it.each(['https://dЬs.com.sg/', 'https://d%D0%ACs.com.sg/', 'https://παράδειγμα.com/'])('explains observed non-Latin letters in %s', async address => {
    const tool = options();
    const result = await collectEvidence(input(address), null, tool);
    expect(domain(result).state).toBe('unsupported');
    expect(domain(result).detail).toContain('hostname contains a non-Latin letter');
    expect(domain(result).detail).toContain('Punycode (xn--)');
    expect(domain(result).detail).toContain('Character lookalikes have not been assessed');
    expect(domain(result).detail).not.toContain('Actual host: dbs.com.sg.');
    expect(reputation(result).state).toBe('unsupported');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });

  it('does not describe accented Latin letters as non-Latin or proven malicious', async () => {
    const result = await collectEvidence(input('https://bücher.de/'), null, options());
    expect(domain(result).state).toBe('unsupported');
    expect(domain(result).detail).toContain('non-ASCII characters');
    expect(domain(result).detail).not.toContain('non-Latin letter');
    expect(domain(result).detail).not.toMatch(/is (?:malicious|fraudulent|safe)/i);
  });

  it('describes supplied Punycode without guessing which Unicode character it encodes', async () => {
    const result = await collectEvidence(input('https://xn--ds-mnc.com.sg/'), null, options());
    expect(domain(result).state).toBe('unsupported');
    expect(domain(result).detail).toContain('uses Punycode (xn--) to encode international characters');
    expect(domain(result).detail).not.toContain('non-Latin letter');
    expect(domain(result).detail).toContain('not been matched to an organisation');
  });
});

describe('explanation changes preserve lookup and directory boundaries', () => {
  it('adds redirect limitations to a reviewed shortener without inspecting its destination', async () => {
    const tool = options();
    const result = await collectEvidence(input('https://go.gov.sg/unknown-path'), null, tool);
    expect(domain(result).state).toBe('matched');
    expect(domain(result).detail).toContain('does not open the link or follow redirects');
    expect(domain(result).detail).toContain('does not authenticate the sender');
    expect(reputation(result).state).toBe('unsupported');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });

  it('still reserves exactly once for an eligible homepage and never visits that website', async () => {
    const tool = options();
    const result = await collectEvidence(input('https://www.dbs.com.sg/'), null, tool);
    expect(domain(result).state).toBe('matched');
    expect(reputation(result).state).toBe('no_match');
    expect(reputation(result).detail).toContain('does not establish safety');
    expect(tool.reserveLookup).toHaveBeenCalledTimes(1);
    expect(tool.fetcher).toHaveBeenCalledTimes(1);
    const endpoint = new URL(String(tool.fetcher.mock.calls[0][0]));
    expect(endpoint.origin).toBe('https://webrisk.googleapis.com');
    expect(endpoint.searchParams.get('uri')).toBe('https://www.dbs.com.sg/');
  });

  it('never reserves for a screenshot link even when its host is eligible', async () => {
    const tool = options();
    const extraction: Extraction = { transcript: 'https://www.dbs.com.sg/', claimedOrganisation: null, urls: [], phoneNumbers: [], requestedActions: [], unreadableDetails: [], missingContext: [] };
    const result = await collectEvidence(input('', { mode: 'screenshot' }), extraction, tool);
    expect(domain(result).state).toBe('matched');
    expect(reputation(result).state).toBe('unsupported');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });

  it('retains expiry and opt-out states alongside structure explanations', async () => {
    const tool = { ...options(), now: new Date('2026-11-01T00:00:00Z') };
    const result = await collectEvidence(input('https://www.dbs.com.sg/', { externalLookup: false }), null, tool);
    expect(domain(result).state).toBe('unavailable');
    expect(domain(result).detail).toContain('record is outside its review window');
    expect(reputation(result).state).toBe('not_checked');
    expect(tool.reserveLookup).not.toHaveBeenCalled();
    expect(tool.fetcher).not.toHaveBeenCalled();
  });
});
