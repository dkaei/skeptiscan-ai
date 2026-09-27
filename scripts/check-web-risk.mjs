import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = promisify(execFile);
// Fixed public test data only. Never accept a submitted URL or open these sites.
const FIXTURES = Object.freeze([
  Object.freeze({ id: 'google_malware_fixture', uri: 'http://testsafebrowsing.appspot.com/s/malware.html', expected: 'matched', route: 'transport' }),
  Object.freeze({ id: 'public_origin_control', uri: 'https://example.com/', expected: 'no_match', route: 'product' }),
]);
export const SNAPSHOT_SQL = 'SELECT lookup_count,halted FROM budget WHERE id=1;';
export const RESERVATION_SQL = 'UPDATE budget SET lookup_count=lookup_count+1 WHERE id=1 AND lookup_count<1000 AND halted=0 AND lookup_count=:previous_count RETURNING lookup_count;';

export function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return 'offline';
  if (args.length === 1 && args[0] === '--live') return 'live';
  throw new Error('unsupported_arguments');
}

// Only documented Google ErrorInfo reason codes survive. Never retain its
// message, project metadata, links, submitted values or unknown reason strings.
export async function googleFailureReason(response) {
  const allowed = new Set(['SERVICE_DISABLED', 'BILLING_DISABLED', 'API_KEY_INVALID',
    'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED',
    'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED', 'CONSUMER_INVALID',
    'CONSUMER_SUSPENDED', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_QUOTA_EXCEEDED']);
  if (!response.body) return 'UNCLASSIFIED';
  const reader = response.body.getReader();
  try {
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { void reader.cancel().catch(() => {}); return 'UNCLASSIFIED'; }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    const details = JSON.parse(bytes.toString('utf8'))?.error?.details;
    if (!Array.isArray(details)) return 'UNCLASSIFIED';
    const info = details.find(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
      && item.domain === 'googleapis.com' && allowed.has(item.reason));
    return info?.reason ?? 'UNCLASSIFIED';
  } catch { return 'UNCLASSIFIED'; }
  finally { reader.releaseLock(); }
}

function childEnvironment() {
  const env = {};
  // Wrangler uses its existing local OAuth session or an already configured CF
  // token. Do not pass Google/OpenAI keys or application secrets to the child.
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // --json still uses Wrangler's normal stdout logger. An error-only log level
  // suppresses the reservation receipt even when the query succeeds.
  return { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
}

/** One atomic remote reservation, never an AI admission or a counter reset.
 * Ambiguous CLI failures stop the probe: the counter may already have changed.
 */
export async function reserveRemoteLookup({ root = ROOT, execute = EXEC } = {}) {
  const query = async sql => {
    let stdout;
    try {
      ({ stdout } = await execute(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
        'd1', 'execute', 'DB', '--remote', '--config', resolve(root, 'wrangler.jsonc'),
        '--command', sql, '--json'], {
        cwd: root, env: childEnvironment(), windowsHide: true, timeout: 30_000, maxBuffer: 65_536,
      }));
    } catch { throw new Error('remote_reservation_unconfirmed'); }
    let body;
    try { body = JSON.parse(stdout); } catch { throw new Error('remote_reservation_unconfirmed'); }
    const row = Array.isArray(body) && body.length === 1 ? body[0] : null;
    if (!row || row.success !== true || !Array.isArray(row.results) || row.results.length !== 1) throw new Error('remote_reservation_unconfirmed');
    return row;
  };
  const before = (await query(SNAPSHOT_SQL)).results[0];
  if (!Number.isInteger(before.lookup_count) || before.lookup_count < 0 || before.lookup_count >= 1000 || before.halted !== 0) throw new Error('remote_reservation_unconfirmed');
  // A replay after an ambiguous control-plane response cannot reserve again.
  // Contention deliberately fails closed; do not retry with a new counter.
  const reserved = await query(RESERVATION_SQL.replace(':previous_count', String(before.lookup_count)));
  if (reserved.meta?.changes !== 1 || reserved.results[0].lookup_count !== before.lookup_count + 1) throw new Error('remote_reservation_unconfirmed');
  return reserved.results[0].lookup_count;
}

/** Injectable only for offline tests. The live CLI supplies the actual shared
 * transport/collector, native fetch and REMOTE reservation function below. */
export async function runFixedSmoke({ key, lookupWebRisk, collectEvidence, reserveLookup, fetcher = fetch, record = async () => {} }) {
  const results = [];
  for (const fixture of FIXTURES) {
    const started = Date.now();
    await record({ event: 'reservation_started', fixture: fixture.id });
    let count;
    try { count = await reserveLookup(); }
    catch {
      const result = { fixture: fixture.id, state: 'not_dispatched', passed: false,
        code: 'remote_reservation_unconfirmed', lookupCount: null, requests: 0, httpStatus: null, durationMs: Date.now() - started };
      await record({ event: 'result', ...result }); results.push(result); break;
    }
    await record({ event: 'reservation_confirmed', fixture: fixture.id, lookupCount: count });
    let permitUsed = false, requests = 0, httpStatus = null, requestFailed = false, providerReason = null;
    const guardedFetch = async (url, init) => {
      const endpoint = new URL(String(url));
      if (requests !== 0 || endpoint.origin + endpoint.pathname !== 'https://webrisk.googleapis.com/v1/uris:search'
        || endpoint.searchParams.get('uri') !== fixture.uri || !permitUsed) throw new Error('unexpected_provider_request');
      requests++;
      await record({ event: 'provider_dispatch', fixture: fixture.id });
      try {
        const response = await fetcher(url, init);
        httpStatus = response.status;
        if (!response.ok) providerReason = await googleFailureReason(response);
        return response;
      } catch { requestFailed = true; throw new Error('provider_request_failed'); }
    };
    const options = { webRiskKey: key, webRiskEnabled: true, fetcher: guardedFetch,
      // The remote reservation precedes the provider's five-second deadline;
      // one local permit consumes exactly that reservation, once, for this case.
      reserveLookup: async () => { if (permitUsed) throw new Error('permit_already_used'); permitUsed = true; } };
    let value;
    try {
      if (fixture.route === 'transport') value = await lookupWebRisk(new URL(fixture.uri), options);
      else {
        const evidence = await collectEvidence({ mode: 'link', content: fixture.uri, context: '', senderEmail: '', senderPhone: '', externalLookup: true }, null, options);
        value = evidence.find(item => item.kind === 'reputation');
      }
    } catch { value = null; }
    const state = ['matched', 'no_match', 'unavailable', 'unsupported', 'not_checked'].includes(value?.state) ? value.state : 'unavailable';
    const passed = state === fixture.expected && permitUsed && requests === 1 && httpStatus === 200;
    const code = passed ? 'expected_result' : requests === 0 ? 'not_dispatched'
      : requestFailed ? 'provider_request_failed' : httpStatus !== null && httpStatus !== 200 ? 'provider_http_failure'
      : state === 'unavailable' ? 'provider_result_unavailable' : 'unexpected_result';
    const result = { fixture: fixture.id, state, passed, code, providerReason, lookupCount: count, requests, httpStatus, durationMs: Date.now() - started };
    await record({ event: 'result', ...result }); results.push(result);
    // Do not turn authentication, quota, timeout or malformed-response failures
    // into another provider attempt. There are no retries.
    if (!passed) break;
  }
  return { passed: results.length === 2 && results.every(item => item.passed), results };
}

async function loadRuntime() {
  const { build } = await import('esbuild');
  const result = await build({ stdin: { contents: "export { lookupWebRisk } from './server/web-risk'; export { collectEvidence } from './server/evidence';", resolveDir: ROOT, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

async function localKey() {
  let key = process.env.GOOGLE_WEB_RISK_API_KEY;
  if (!key) {
    try { key = parseEnv(await readFile(resolve(ROOT, '.dev.vars'), 'utf8')).GOOGLE_WEB_RISK_API_KEY; }
    catch { throw new Error('local_key_unavailable'); }
  }
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key) || key.length > 512) throw new Error('local_key_unavailable');
  return key;
}

export async function main(args = process.argv.slice(2)) {
  const mode = parseMode(args);
  if (mode === 'offline') {
    console.log('Offline: no secrets read, ledger changes or network calls. After private key setup, node scripts/check-web-risk.mjs --live runs at most two fixed Google lookups, reserving the existing REMOTE D1 lookup allowance. It consumes no AI admission, never opens a submitted site, and does not enable the app feature.');
    return;
  }
  const key = await localKey();
  await access(resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js'));
  const runtime = await loadRuntime();
  const receiptDir = resolve(ROOT, 'verification/web-risk-readiness');
  await mkdir(receiptDir, { recursive: true });
  const receiptName = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`;
  const receipt = await open(resolve(receiptDir, receiptName), 'wx');
  const record = async value => { await receipt.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`); await receipt.sync(); };
  try {
    await record({ event: 'start', schemaVersion: 1, remoteLookupReservations: true, aiAdmissions: 0, maximumProviderRequests: 2 });
    const result = await runFixedSmoke({ key, ...runtime, reserveLookup: () => reserveRemoteLookup(), record });
    await record({ event: 'finished', passed: result.passed });
    console.log(JSON.stringify({ passed: result.passed, receipt: `verification/web-risk-readiness/${receiptName}`, results: result.results }));
    if (!result.passed) process.exitCode = 1;
  } finally { await receipt.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Web Risk readiness stopped. Check private key configuration, local dependencies and Wrangler remote D1 access. No automatic retry was made; an unconfirmed reservation may still have consumed a lookup.'); process.exitCode = 1; });
}
