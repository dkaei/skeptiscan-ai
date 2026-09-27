import { parse as parseDomain } from 'tldts';
import { lookupWebRisk } from './web-risk';
import { findPhoneNumbersInText, parsePhoneNumberFromString } from 'libphonenumber-js';
import type { CheckInput, Evidence, Extraction } from '../shared/contracts';
import { isCurrentSource, REVIEWED_ORGANISATIONS, selectGuidance } from './guidance';
import { internationalHostnameExplanation, urlComponentExplanation } from './url-explanation';

export interface EvidenceOptions {
  webRiskKey?: string;
  webRiskEnabled?: boolean;
  signal?: AbortSignal;
  now?: Date;
  fetcher?: typeof fetch;
  /** Must atomically reserve a global lookup before dispatch. Never optional for live calls. */
  reserveLookup?: () => Promise<void>;
}

const WEB_RISK_SOURCE = 'https://docs.cloud.google.com/web-risk/docs/lookup-api';
const MAX_LOCAL_URLS = 6;
const MAX_LOOKUPS = 3;
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|onion|test|example|invalid)$/i;

/** Extract candidates only. This never opens a link and does not declare it valid. */
export function extractUrls(text: string): string[] {
  const pattern = /(?<![\p{L}\p{N}_@.\-])(?:(?:https?:\/*|[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"'`]+|(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+(?:[\p{L}]{2,63}|xn--[a-z\d-]+)\.*(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?)/giu;
  const candidates: string[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    let literal = match[0];
    const token = text.slice(match.index).match(/^[^\s<>"'`]+/)?.[0] ?? literal;
    const authority = token.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
    // A domain-shaped username is not a standalone hostname. Keep the whole
    // authority-like token, including empty/nonnumeric password fields, and
    // consume it so domains inside credentials cannot become later candidates.
    if (authority.includes('@') || /^[:@]/.test(token.slice(literal.length))) {
      literal = token;
      pattern.lastIndex = match.index + token.length;
    }
    let value = literal.replace(/[,;:!?]+$/, '');
    while (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1);
    while (value.endsWith(']') && (value.match(/\]/g)?.length ?? 0) > (value.match(/\[/g)?.length ?? 0)) value = value.slice(0, -1);
    // A hostname's single root dot is valid; repeated dots are malformed. Do
    // not erase either into a different eligible address as sentence punctuation.
    const withoutScheme = value.replace(/^[a-z][a-z\d+.-]*:\/\//i, '');
    if (/[/?#]/.test(withoutScheme)) value = value.replace(/\.+$/, '');
    if (value && !candidates.includes(value)) candidates.push(value);
  }
  return candidates;
}

interface ParsedLink { url?: URL; host?: string; domain?: string; privateSuffix?: boolean; problem?: string }

function parseLink(value: string): ParsedLink {
  if (value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return { problem: 'The address contains unsupported characters or exceeds the link-length limit.' };
  try {
    const address = value.startsWith('//') ? `https:${value}` : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
    // WHATWG parsing removes empty userinfo and repairs missing/extra slashes.
    // Check the submitted authority before those literal distinctions are lost.
    const authority = address.match(/^https?:\/\/([^/?#]*)/i)?.[1];
    if (!authority) return { problem: 'Only ordinary HTTP or HTTPS website addresses with a complete host are supported. The address was not repaired or sent externally.' };
    const url = new URL(address);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const parsed = parseDomain(host, { allowPrivateDomains: true });
    const base = { url, host, domain: parsed.domain ?? undefined, privateSuffix: parsed.isPrivate ?? false };
    if (!['https:', 'http:'].includes(url.protocol)) return { ...base, problem: 'Only ordinary HTTP or HTTPS website addresses are supported.' };
    if (authority.includes('@') || url.username || url.password) return { ...base, problem: 'Text before @ is user information, not the destination hostname. This field is unsupported even when empty. The link will not be sent to a reputation service or treated as an organisation match.' };
    if (host.split('.').some(label => label.length === 0)) return { ...base, problem: 'This hostname contains an empty label or more than one trailing dot. It has not been repaired, matched to an organisation or sent externally.' };
    if (parsed.isIp || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return { ...base, problem: 'IP-address URLs are not supported for organisation matching or external lookup.' };
    if (/(?:^|\.)xn--/i.test(host)) return { ...base, problem: internationalHostnameExplanation(authority) };
    if (!host || PRIVATE_SUFFIX.test(host) || !parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) return { ...base, problem: 'This is a private, reserved or unsupported domain. No external lookup was performed.' };
    if (url.port) return { ...base, problem: 'An address with a nonstandard port is not supported for external lookup or organisation matching.' };
    return base;
  } catch {
    return { problem: 'The supplied address could not be parsed as a website URL.' };
  }
}

function containsAlias(text: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

function externalPrivacyReason(link: ParsedLink, value: string, input: CheckInput): string | undefined {
  if (link.problem || !link.url || !link.host || !link.domain) return link.problem ?? 'This address is unsupported.';
  if (link.privateSuffix) return 'Privately hosted user-content domains are excluded from external lookup.';
  if (link.url.search || link.url.hash || !['', '/'].includes(link.url.pathname) || value.includes('%')) {
    return 'This prototype does not send URL paths, queries, fragments or encoded values to a third party because they may contain private information or access tokens. The full link was not reputation-checked.';
  }
  if (link.host !== link.domain && link.host !== `www.${link.domain}`) return 'This subdomain may identify a private service or contain a token. It has not been sent externally.';
  if (input.mode === 'screenshot') return 'Image-extracted links need review before external lookup. Only local URL checks were performed.';
  return undefined;
}

export async function collectEvidence(input: CheckInput, extraction: Extraction | null, options: EvidenceOptions = {}): Promise<Evidence[]> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const evidence: Evidence[] = [];
  const add = (item: Omit<Evidence, 'checkedAt'>) => evidence.push({ ...item, checkedAt });
  // Model-produced text is evidence of image interpretation only, not a verified source.
  const text = [input.content, input.context, input.mode === 'screenshot' ? extraction?.transcript ?? '' : ''].join('\n');
  const singleLink = input.mode === 'link' && input.content.trim() && !/\s/.test(input.content.trim());
  // A literal link is one candidate, not a source of repaired host substrings.
  // Keep separately supplied context links available for their own checks.
  const candidates = singleLink ? [...new Set([input.content.trim(), ...extractUrls(input.context)])] : extractUrls(text);
  let lookups = 0;
  const seen = new Set<string>();
  for (const [index, value] of candidates.slice(0, MAX_LOCAL_URLS).entries()) {
    const link = parseLink(value);
    const key = link.problem ? value : link.url?.href ?? value;
    if (seen.has(key)) continue;
    seen.add(key);
    const structure = link.host ? `Actual host: ${link.host}.${link.domain ? ` Registrable domain: ${link.domain}.` : ''} ${link.url ? `${urlComponentExplanation(link.url)} ` : ''}` : '';
    if (link.problem) {
      add({ id: `domain-${index}`, kind: 'domain', state: 'unsupported', title: 'Limited URL check', detail: structure + link.problem });
    } else {
      const exact = REVIEWED_ORGANISATIONS.find(record => record.hosts.includes(link.host!));
      const claimed = REVIEWED_ORGANISATIONS.find(record => record.aliases.some(alias => containsAlias(text, alias)));
      const misleading = REVIEWED_ORGANISATIONS.find(record => record.hosts.some(host => link.host!.startsWith(`${host}.`) || link.host!.includes(`.${host}.`)));
      if (exact) {
        const current = isCurrentSource(exact, now);
        add({ id: `domain-${index}`, kind: 'domain', state: current ? 'matched' : 'unavailable', title: current ? `Host matches the reviewed ${exact.name} record` : 'Organisation record needs review',
          detail: current ? `${structure}Exact host match to a record reviewed ${exact.reviewedAt.slice(0, 10)}. This does not authenticate the sender, verify a redirect destination or authorise the requested action.` : `${structure}The stored host record is outside its review window; no current organisation match is asserted.`, sourceUrl: exact.sourceUrl });
      } else if (misleading && isCurrentSource(misleading, now)) {
        add({ id: `domain-${index}`, kind: 'domain', state: 'observation', title: 'An organisation address appears inside another host', detail: `${structure}${misleading.name}’s listed host appears as leading text within a different domain. This is not an exact organisation-host match.`, sourceUrl: misleading.sourceUrl });
      } else {
        const currentClaim = claimed && isCurrentSource(claimed, now) ? claimed : undefined;
        add({ id: `domain-${index}`, kind: 'domain', state: 'no_match', title: 'Host is outside the reviewed directory', detail: `${structure}${currentClaim ? `The text mentions ${currentClaim.name}, but this is not one of its exact hosts in this small directory. ` : ''}Unlisted services may be legitimate; missing coverage does not establish fraud or safety.`, ...(currentClaim ? { sourceUrl: currentClaim.sourceUrl } : {}) });
      }
    }
    const privacyReason = externalPrivacyReason(link, value, input);
    if (privacyReason) add({ id: `reputation-${index}`, kind: 'reputation', state: 'unsupported', title: 'External link check not performed', detail: privacyReason });
    else if (!input.externalLookup) add({ id: `reputation-${index}`, kind: 'reputation', state: 'not_checked', title: 'External link check is off', detail: 'Only local URL and directory checks were performed. The address was not sent to Google Web Risk.' });
    else if (!options.webRiskEnabled || !options.webRiskKey || !options.reserveLookup) add({ id: `reputation-${index}`, kind: 'reputation', state: 'unavailable', title: 'Link reputation is unavailable', detail: 'A live lookup requires configured provider access and a persistent lookup allowance. No reputation result is available.' });
    else if (lookups >= MAX_LOOKUPS) add({ id: `reputation-${index}`, kind: 'reputation', state: 'not_checked', title: 'Link-check limit reached', detail: 'This check permits at most three external URL lookups. This URL was not sent externally.' });
    else {
      lookups++;
      const result = await lookupWebRisk(link.url!, options, now);
      add({ id: `reputation-${index}`, kind: 'reputation', title: 'Google Web Risk lookup', ...result, sourceUrl: WEB_RISK_SOURCE });
    }
  }
  if (candidates.length > MAX_LOCAL_URLS) add({ id: 'url-limit', kind: 'input', state: 'not_checked', title: 'Additional links were not checked', detail: 'Only the first six distinct URL candidates receive local checks. Narrow the input to the links relevant to this request.' });
  if (input.mode === 'link' && !candidates.length) add({ id: 'url-missing', kind: 'domain', state: 'unsupported', title: 'No supported URL could be extracted', detail: 'Enter a complete website address. No external lookup was performed.' });

  const phoneCandidates = [input.senderPhone, ...findPhoneNumbersInText(text, 'SG').map(match => match.number.number)].filter(Boolean);
  const phoneSeen = new Set<string>();
  for (const candidate of phoneCandidates.slice(0, 5)) {
    const phone = parsePhoneNumberFromString(candidate, { defaultCountry: 'SG', extract: false });
    const key = phone?.number ?? candidate;
    if (phoneSeen.has(key)) continue;
    phoneSeen.add(key);
    const normalised = phone?.isValid() ? phone.number : null;
    const valid = normalised !== null;
    add({ id: `phone-${phoneSeen.size}`, kind: 'phone', state: valid ? 'unavailable' : 'unsupported', title: valid ? 'Phone reputation is unavailable' : 'Phone number could not be normalised',
      detail: valid ? `Interpreted as ${normalised}${candidate.startsWith('+') ? '' : ' using Singapore as the default country'}. This is format information only. No authorised reported-number feed is connected; the caller’s identity and report history were not verified.` : 'The supplied number is incomplete, masked or unsupported. No number-report lookup or caller authentication was performed.' });
  }
  if (input.mode === 'call' && !phoneSeen.size) add({ id: 'phone-unavailable', kind: 'phone', state: 'unavailable', title: 'Caller identity is not verified', detail: 'No complete number was extracted and no authorised reported-number feed is connected. The supplied description can still be assessed for the action requested.' });
  // A literal quote does not validate a model's interpretation of that quote.
  // Retrieve from submitted text/transcript; action labels may erase negation.
  evidence.push(...selectGuidance(text, now));
  return evidence;
}
