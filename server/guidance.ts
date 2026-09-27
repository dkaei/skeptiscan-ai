import type { Evidence } from '../shared/contracts';

/** These are small, manually checked records, not a live or comprehensive registry. */
export interface ReviewedSource {
  id: string;
  title: string;
  sourceUrl: string;
  reviewedAt: string;
  expiresAt: string;
}

const reviewDates = {
  reviewedAt: '2026-09-26T00:00:00.000Z',
  expiresAt: '2026-10-26T00:00:00.000Z',
};

export interface ReviewedOrganisation extends ReviewedSource {
  name: string;
  aliases: readonly string[];
  hosts: readonly string[];
}

export const REVIEWED_ORGANISATIONS: readonly ReviewedOrganisation[] = [
  { id: 'gov-sg', name: 'Singapore Government', aliases: ['singapore government', 'gov.sg'],
    hosts: ['gov.sg', 'www.gov.sg', 'go.gov.sg'], title: 'Official government website guidance',
    sourceUrl: 'https://www.gov.sg/trusted-sites/', ...reviewDates },
  { id: 'spf', name: 'Singapore Police Force', aliases: ['singapore police force', 'spf'],
    hosts: ['police.gov.sg', 'www.police.gov.sg'], title: 'Singapore Police Force advisory',
    sourceUrl: 'https://www.police.gov.sg/Media-Hub/News/2026/06/20260609_joint_advisory_on_technical_support_scams_involving_the_impersonation_of_microsoft', ...reviewDates },
  { id: 'dbs', name: 'DBS', aliases: ['dbs'],
    hosts: ['dbs.com.sg', 'www.dbs.com.sg'], title: 'DBS security guidance',
    sourceUrl: 'https://www.dbs.com.sg/personal/deposits/security-and-you/default.page', ...reviewDates },
  { id: 'singpost', name: 'SingPost', aliases: ['singpost', 'singapore post'],
    hosts: ['singpost.com', 'www.singpost.com'], title: 'SingPost online security guidance',
    sourceUrl: 'https://www.singpost.com/online-security-you', ...reviewDates },
];

export interface GuidanceRecord extends ReviewedSource {
  /** Plain paraphrase with its original scope, not an assessment of user content. */
  excerpt: string;
}

export const GUIDANCE: readonly GuidanceRecord[] = [
  { id: 'account-credentials', title: 'Keep banking credentials private',
    sourceUrl: 'https://www.dbs.com.sg/personal/deposits/security-and-you/default.page',
    excerpt: 'DBS advises against giving another person banking credentials, one-time passwords or Digital Token approvals. This source concerns account authentication; it does not classify ordinary parcel-collection codes.',
    ...reviewDates },
  { id: 'parcel-payment', title: 'Confirm a delivery or marketplace request independently',
    sourceUrl: 'https://www.police.gov.sg/media-hub/news/2025/02/20250212_police_advisory_on-phishing_scams_involving_fake_buyers_on_online_marketplaces',
    excerpt: 'SPF advises against opening dubious payment links or QR codes in marketplace and delivery messages. If uncertain, verify the request directly with the marketplace or delivery company through an independently chosen official channel.',
    ...reviewDates },
  { id: 'remote-access', title: 'Check unexpected technical-support requests',
    sourceUrl: 'https://www.police.gov.sg/Media-Hub/News/2026/06/20260609_joint_advisory_on_technical_support_scams_involving_the_impersonation_of_microsoft',
    excerpt: 'SPF describes technical-support scams that ask people to download remote-access software or grant control of their device. Confirm an unexpected support request through the software provider’s official channels before following its instructions.',
    ...reviewDates },
  { id: 'whatsapp-account', title: 'Protect WhatsApp account codes',
    sourceUrl: 'https://www.police.gov.sg/media-hub/news/2026/05/20260508_police_advisory_on_social_media_impersonation_scams',
    excerpt: 'SPF warns that a compromised WhatsApp account can send requests appearing to come from a familiar person. Do not give another person the one-time password used to access your WhatsApp account.',
    ...reviewDates },
  { id: 'government-host', title: 'Check the actual government website address',
    sourceUrl: 'https://www.gov.sg/trusted-sites/',
    excerpt: 'Singapore government websites generally use .gov.sg. Government guidance lists exceptions and official short-link hosts. A name appearing earlier in an unrelated hostname is not a match, and a genuine host does not authenticate a separate message or payment request.',
    ...reviewDates },
];

const SHARE = /\b(?:send(?:ing)?|share|sharing|tell|telling|read(?:ing)?(?:\s+out)?|give|giving|forward(?:ing)?|relay(?:ing)?|provide|providing|disclose|disclosing|reveal(?:ing)?)\b/gi;
const ASK_FOR = /\b(?:(?:asks?|asked|asking)\s+(?:(?:me|us|you)\s+)?for|requests?|requesting|needs?|wants?)\b/gi;
const APPROVE = /\b(?:approve|approving|authorise|authorize|accept)\b/gi;
const AUTH_SECRET = /\b(?:passwords?|otps?|one[ -]time (?:password|login code)|(?:banking|account|login|log[ -]?in|authentication|verification|security) (?:codes?|pins?|credentials?)|digital token)\b/i;
const BANK_CONTEXT = /\b(?:bank|banking|account|login|log[ -]?in|authentication|digital token)\b/i;
const DELIVERY = /\b(?:parcel|delivery|redelivery|courier|singpost|marketplace|buyer|seller)\b/i;
const PAY = /\b(?:pay(?:ing)?|transfer(?:ring)?|remit|send(?:ing)?)\b/gi;
const OPEN_LINK = /\b(?:open(?:ing)?|visit(?:ing)?|click(?:ing)?|tap(?:ping)?|follow(?:ing)?|scan(?:ning)?)\b/gi;
const INSTALL = /\b(?:install(?:ed|ing)?|download(?:ed|ing)?|grant(?:ing)?|allow(?:ing)?|enable|enabling|connect(?:ing)?)\b/gi;
const WEBSITE = /\b(?:(?:government|police|official|spf|ministry)\s+)?(?:website|web address|hostname|domain|url|link)\b/gi;
const PASSIVE_SHARE = /\b(?:sent|shared|given|forwarded|relayed|provided|disclosed|revealed)\b/i;
const PASSIVE_PAY = /\b(?:paid|transferred|remitted|sent)\b/i;
const PASSIVE_APPROVE = /\b(?:approved|authorised|authorized|accepted)\b/i;
const PASSIVE_ACTIONS = new RegExp([PASSIVE_SHARE, PASSIVE_PAY, PASSIVE_APPROVE].map(pattern => pattern.source).join('|'), 'i');
// Track coordination across verb families: "do not pay ... or click ..."
// has one negative scope even though payment and link retrieval are separate.
const ACTIONS = new RegExp([SHARE, ASK_FOR, APPROVE, PAY, OPEN_LINK, INSTALL, PASSIVE_ACTIONS].map(pattern => pattern.source).join('|'), 'gi');
// Include every adverb accepted by PASSIVE_DEMAND, so the same request keeps
// its negative scope when an adverb appears before or after "be".
const NEGATIVE_PREFIX = /\b(?:no(?:body| one)?|never|not|don't|doesn't|didn't|won't|wouldn't|shouldn't|mustn't|without|refus(?:e|es|ed|ing)|declin(?:e|es|ed|ing))\s+(?:(?:ever|please|directly|immediately|now|also|actually|am|is|are|was|were|be|being|been|have|has|had|ask|asks|asked|asking|tell|telling|told|need|needs|want|wanted|wants|request|requests|requested|requesting|requirement|required|supposed|going|to|me|us|you|anyone|someone)\s+)*$/i;
const PASSIVE_DEMAND = /\b(?:must|should|shall|(?:need|needs|has|have|had)\s+to|(?:is|are|was|were)\s+(?:required|expected|supposed)\s+to)\s+(?:(?:not|never|also|now)\s+)*be\s+(?:(?:directly|immediately|now)\s+)*$/i;

/** Small English retrieval rules, not a scam/legitimacy classifier. Topic words
 * alone do not make a source applicable. Split mixed requests so a negated
 * clause cannot suppress a separate affirmative request. */
function requestClauses(text: string): string[] {
  return text.replace(/[’‘]/g, "'")
    .split(/(?:[;!?\n]+|\.(?=\s|$)|\s+\b(?:but|however|instead|yet)\b\s+|\s+and\s+(?=(?:please|then|now|they|he|she|someone|the (?:caller|sender))\b)|,\s*(?=(?:please\s+)?(?:send|share|tell|read|give|forward|provide|install|download|pay|transfer|open|click|tap)\b))/i)
    .map(clause => clause.trim()).filter(Boolean);
}

function absentObjectToAct(before: string): boolean {
  // "No delivery fee to pay" negates an object, rather than the verb.
  // Bound the noun phrase and reject conjunctions so a later demand survives.
  const phrase = /\bno\s+([a-z][a-z -]{0,80})\s+to\s*$/i.exec(before)?.[1];
  return Boolean(phrase && phrase.split(/\s+/).length <= 8
    && !/\b(?:and|or|but|then|however|instead)\b/i.test(phrase)
    && /\b(?:fees?|payments?|charges?|money|passwords?|codes?|pins?|credentials?|request|requirement|need)\s*$/i.test(phrase));
}

function hasRequest(clause: string, actions: RegExp, passiveActions?: RegExp): boolean {
  const selectedAction = new RegExp(`^(?:${actions.source})$`, 'i');
  const selectedPassive = passiveActions && new RegExp(`^(?:${passiveActions.source})$`, 'i');
  let previousWasNegated = false;
  // Website nouns have their own negation scope; an object such as "website"
  // must not reset an earlier negative instruction to open or scan it.
  for (const match of clause.matchAll(actions === WEBSITE ? WEBSITE : ACTIONS)) {
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length);
    if (/^requests?$/i.test(match[0]) && /\b(?:a|an|the|this|that|your|my|our|their|token)\s*$/i.test(before)) continue;
    const passive = PASSIVE_ACTIONS.test(match[0]);
    // A code the app "sent" is not a demand to disclose it. Admit these past
    // participles only with an explicit modal/obligation, e.g. "must be sent".
    if (passive && !PASSIVE_DEMAND.test(before)) continue;
    // Restrict negation to the action's grammatical prefix. "Not a scam" or
    // "do not worry" must not suppress a later explicit sharing request.
    const negativePrefix = NEGATIVE_PREFIX.exec(before);
    const negatedRefusal = negativePrefix && /^(?:refus|declin)/i.test(negativePrefix[0])
      && /\b(?:not|never|don't|doesn't|didn't|won't|wouldn't|shouldn't|mustn't)\s*$/i.test(before.slice(0, negativePrefix.index));
    const coordinatedNegation = previousWasNegated && /\b(?:and|or)\s*$/i.test(before);
    if ((negativePrefix && !negatedRefusal) || absentObjectToAct(before) || /^\s+(?:no|neither)\b/i.test(after) || coordinatedNegation) {
      previousWasNegated = true;
      continue;
    }
    previousWasNegated = false;
    if (selectedAction.test(match[0]) || selectedPassive?.test(match[0])) return true;
  }
  return false;
}

function relevantGuidanceIds(text: string): Set<string> {
  const ids = new Set<string>();
  const clauses = requestClauses(text);
  for (const [index, clause] of clauses.entries()) {
    // Adjacent context covers "Parcel held. Pay the fee" without allowing an
    // unrelated topic anywhere in a long message to select a reference.
    const nearby = [clauses[index - 1] ?? '', clause].join(' ');
    const sharing = hasRequest(clause, SHARE, PASSIVE_SHARE) || hasRequest(clause, ASK_FOR);
    const parcelCollection = DELIVERY.test(nearby) && /\b(?:collection|collect|pickup|pick[ -]?up|locker)\b/i.test(nearby);
    const accountSecret = AUTH_SECRET.test(clause) || (/\bpins?\b/i.test(clause) && BANK_CONTEXT.test(nearby));
    const tokenApproval = /\bdigital token\b/i.test(clause) && hasRequest(clause, APPROVE, PASSIVE_APPROVE);
    if (((sharing && accountSecret) || tokenApproval) && (!parcelCollection || BANK_CONTEXT.test(clause))) ids.add('account-credentials');

    const whatsappAccount = /\bwhatsapp\b/i.test(nearby) && /\b(?:register(?:ed|ing)?|registration|account|login|log[ -]?in|verification)\b/i.test(nearby);
    if (sharing && whatsappAccount && /\b(?:codes?|otps?|passwords?)\b/i.test(clause) && !/\b(?:bank|banking)\b/i.test(clause)) ids.add('whatsapp-account');

    const payment = /(?:\b(?:pay(?:ing)?|payment|fee|money|refund|deposit)\b|(?:S\$|\$)\s*\d|\bSGD\s*\d)/i.test(clause);
    const link = /(?:https?:\/\/|www\.|\b(?:link|url|website|qr(?: code)?)\b)/i.test(clause);
    if (DELIVERY.test(nearby) && ((payment && (hasRequest(clause, PAY, PASSIVE_PAY) || hasRequest(clause, ASK_FOR))) || (link && hasRequest(clause, OPEN_LINK)))) {
      ids.add('parcel-payment');
    }

    const remoteTool = /\b(?:remote[ -](?:access|control)|remote access|remote control|anydesk|teamviewer|screen[ -]?shar\w*)\b/i.test(clause);
    const supportSoftware = /\b(?:technical support|support (?:agent|caller|team)|helpdesk)\b/i.test(nearby) && /\b(?:app|software|program|application)\b/i.test(clause);
    if ((remoteTool || supportSoftware) && (hasRequest(clause, INSTALL) || hasRequest(clause, ASK_FOR))) ids.add('remote-access');

    // This source explains website addresses, not police report databases or
    // authority claims. A host/link question must actually be present.
    const authority = /\b(?:government|gov\.sg|police|spf|ministry)\b/i.test(nearby);
    const website = /(?:https?:\/\/|www\.|\bgov\.sg\b)/i.test(clause) || hasRequest(clause, WEBSITE);
    if (authority && website) ids.add('government-host');
  }
  return ids;
}

export function isCurrentSource(source: ReviewedSource, now: Date): boolean {
  const reviewed = Date.parse(source.reviewedAt);
  const expires = Date.parse(source.expiresAt);
  return Number.isFinite(now.getTime()) && Number.isFinite(reviewed) && Number.isFinite(expires)
    && reviewed <= now.getTime() && now.getTime() < expires && reviewed < expires;
}

export function selectGuidance(text: string, now = new Date()): Evidence[] {
  const relevant = relevantGuidanceIds(text);
  return GUIDANCE.filter(record => relevant.has(record.id)).slice(0, 3).map(record => {
    const current = isCurrentSource(record, now);
    return {
      id: `guidance-${record.id}`, kind: 'guidance', state: current ? 'observation' : 'unavailable',
      title: current ? record.title : 'Guidance needs a source review',
      detail: current
        ? `${record.excerpt} Source reviewed ${record.reviewedAt.slice(0, 10)}; review expires ${record.expiresAt.slice(0, 10)}. This is reference guidance, not proof about this message.`
        : 'This reference is outside its review window. Its advice has not been supplied as current evidence.',
      sourceUrl: record.sourceUrl, checkedAt: now.toISOString(),
    };
  });
}
