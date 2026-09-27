import type { CheckResult } from '../shared/contracts';

export type LinkInput = { kind: 'invalid' } | { kind: 'website' | 'userinfo'; host: string };

/** Inspect URL structure locally. Never return the embedded username/password. */
export function inspectLinkInput(input: string): LinkInput {
  const value = input.trim();
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return { kind: 'invalid' };
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  const bareHostWithPort = /^[^/?#@:]+\.[^/?#@:]+:\d+(?:[/?#]|$)/.test(value);
  const address = value.startsWith('//') ? `https:${value}` : hasScheme && !bareHostWithPort ? value : `https://${value}`;
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return { kind: 'invalid' };
    const authority = address.match(/^https?:\/\/([^/?#]*)/i)?.[1] ?? '';
    return { kind: url.username || url.password || authority.includes('@') ? 'userinfo' : 'website', host: url.hostname };
  } catch { return { kind: 'invalid' }; }
}

/** A local-only result: no request, reservation, model or external lookup. */
export function localUserinfoResult(host: string, requestId: string, checkedAt: string): CheckResult {
  return {
    requestId, checkedAt, status: 'partial', aiUsed: false,
    title: 'Check the actual destination',
    nextStep: 'Confirm the website through an app or address you already trust.',
    reason: `The text before @ is not the destination. The actual host is ${host}.`,
    uncertainty: 'Address structure alone cannot establish who sent the link or whether it is safe.',
    notice: 'This link contains a username or password field. Only its structure was inspected on this device. Nothing was sent to AI or a reputation service.',
    evidence: [{
      id: 'local-userinfo', kind: 'domain', state: 'unsupported',
      title: 'Actual destination host',
      detail: `${host}. Text before @ is user information, which can contain login details. It is not part of the destination host.`,
      checkedAt,
    }],
    extraction: null, question: null,
  };
}
