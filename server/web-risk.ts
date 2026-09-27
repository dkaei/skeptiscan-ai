import type { Evidence } from '../shared/contracts';

/** Transport only. Product eligibility and user consent remain in evidence.ts.
 * Callers must reserve their persistent lookup allowance before provider dispatch. */
export interface WebRiskOptions {
  webRiskKey?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  reserveLookup?: () => Promise<void>;
}

const WEB_RISK_ENDPOINT = 'https://webrisk.googleapis.com/v1/uris:search';
const THREATS = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'] as const;
const DEADLINE_MS = 5_000;

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > 16_384) throw new Error('oversize');
  if (!response.body) throw new Error('missing response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { void reader.cancel(); throw new Error('oversize'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

export async function lookupWebRisk(link: URL, options: WebRiskOptions, now: Date = new Date()): Promise<Pick<Evidence, 'state' | 'detail'>> {
  const controller = new AbortController();
  let rejectDeadline: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const abort = () => { controller.abort(); rejectDeadline(new Error('lookup unavailable')); };
  const timer = setTimeout(abort, DEADLINE_MS);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('cancelled');
    const operation = async () => {
      await options.reserveLookup!();
      if (controller.signal.aborted || options.signal?.aborted) throw new Error('cancelled');
      const endpoint = new URL(WEB_RISK_ENDPOINT);
      for (const threat of THREATS) endpoint.searchParams.append('threatTypes', threat);
      endpoint.searchParams.set('uri', link.href);
      const response = await (options.fetcher ?? fetch)(endpoint.toString(), {
        method: 'GET', headers: { 'X-Goog-Api-Key': options.webRiskKey!, Accept: 'application/json' },
        // Workers rejects redirect:'error'; manual plus the status guard below
        // prevents following a provider redirect or forwarding its API key.
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || response.redirected) throw new Error('provider unavailable');
      const result = await boundedJson(response);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid response');
      if (Object.keys(result).length === 0) return { state: 'no_match' as const, detail: 'Google Web Risk returned no match in the requested threat lists. This does not establish safety, sender identity or whether a transaction is legitimate.' };
      const threat = (result as Record<string, unknown>).threat;
      if (!threat || typeof threat !== 'object' || Array.isArray(threat)) throw new Error('invalid response');
      const { threatTypes, expireTime } = threat as Record<string, unknown>;
      if (!Array.isArray(threatTypes) || !threatTypes.length || !threatTypes.every(value => typeof value === 'string' && (THREATS as readonly string[]).includes(value))
        || typeof expireTime !== 'string' || !Number.isFinite(Date.parse(expireTime)) || Date.parse(expireTime) <= now.getTime()) throw new Error('invalid or expired response');
      const labels: Record<string, string> = { MALWARE: 'malware', SOCIAL_ENGINEERING: 'social engineering', UNWANTED_SOFTWARE: 'unwanted software' };
      return { state: 'matched' as const, detail: `Google Web Risk lists this link for ${threatTypes.map(t => labels[t]).join(', ')}. The provider response expires ${expireTime}. Google’s list can miss risky sites or flag safe sites; this is not proof of who sent the message.` };
    };
    return await Promise.race([operation(), deadline]);
  } catch {
    return { state: 'unavailable', detail: 'The reputation lookup could not be completed, was cancelled, exceeded its deadline or could not reserve its allowance. No result or safety conclusion is available.' };
  } finally {
    // Also close unread provider bodies on early HTTP/header rejection. Clearing
    // the deadline alone would otherwise leave native fetch work alive.
    controller.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
