import { describe, expect, it } from 'vitest';
import { CheckResultSchema } from '../shared/contracts';
import { inspectLinkInput, localUserinfoResult } from '../src/linkInput';

describe('link input privacy and actual destination', () => {
  it.each([
    ['https://www.dbs.com.sg@accounts.example.org/', 'accounts.example.org'],
    ['https://alice:PRIVATE-PASSWORD@accounts.example.org/', 'accounts.example.org'],
    ['https://alice:p%40ssword@accounts.example.org/', 'accounts.example.org'],
    ['https://first.example@second.example@accounts.example.org/', 'accounts.example.org'],
    ['www.dbs.com.sg@accounts.example.org', 'accounts.example.org'],
    ['//alice:secret@accounts.example.org/', 'accounts.example.org'],
    ['https://@accounts.example.org/', 'accounts.example.org'],
  ])('keeps user information local and identifies the real host for %s', (value, host) => {
    expect(inspectLinkInput(value)).toEqual({ kind: 'userinfo', host });
  });

  it.each([
    ['https://example.org/path@somewhere.example', 'example.org'],
    ['https://example.org/?email=person@somewhere.example', 'example.org'],
    ['https://example.org/#person@somewhere.example', 'example.org'],
    ['https://example.org/%40somewhere.example', 'example.org'],
    ['example.org:8443/path', 'example.org'],
    ['www.example.org', 'www.example.org'],
    [' https://example.org/ ', 'example.org'],
  ])('does not confuse path/query characters or supported input forms with user information: %s', (value, host) => {
    expect(inspectLinkInput(value)).toEqual({ kind: 'website', host });
  });

  it.each([
    '', 'not a website', 'javascript:alert(1)', 'mailto:person@example.org',
    'ftp://alice:secret@example.org/', 'https://example.org\n@other.example',
    'https://trusted.example\\@other.example/', 'https://example.org:99999/',
  ])('rejects malformed or non-website input: %s', value => {
    expect(inspectLinkInput(value)).toEqual({ kind: 'invalid' });
  });

  it('returns an honest local partial result without disclosing embedded credentials', () => {
    const inspected = inspectLinkInput('https://PRIVATE-USER:PRIVATE-PASSWORD@accounts.example.org/');
    expect(inspected.kind).toBe('userinfo');
    if (inspected.kind === 'invalid') throw new Error('Expected a parsed destination');
    const result = localUserinfoResult(inspected.host, 'test-local-request', '2026-09-26T00:00:00.000Z');
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.aiUsed).toBe(false);
    expect(result.extraction).toBeNull();
    expect(result.question).toBeNull();
    expect(result.evidence).toMatchObject([{ kind: 'domain', state: 'unsupported' }]);
    expect(result.reason).toContain('accounts.example.org');
    expect(result.notice).toContain('Nothing was sent to AI or a reputation service');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-USER|PRIVATE-PASSWORD/);
  });
});
