// Presentation only: these observations never determine URL eligibility,
// directory matching, external lookup dispatch or a reputation result.
const REDIRECT_PARAMETER = /^(?:next|continue|redirect|redirect_uri|redirect_url|return|returnto|return_to|return_url|url|dest|destination|target)$/i;

function decodeOnce(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function hostnameText(value: string): string[] {
  // Do not reproduce credentials, email addresses or opaque parameter values.
  // Only hostname-shaped text is displayed, never a full path/query value.
  if (value.includes('@')) return [];
  const names: string[] = [];
  const pattern = /(?<![a-z0-9_.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)(?![a-z0-9_.-])/gi;
  for (const match of value.matchAll(pattern)) {
    const name = match[0].toLowerCase();
    if (name.length <= 253 && !names.includes(name)) names.push(name);
    if (names.length === 2) break;
  }
  return names;
}

/** Explain syntax without opening a URL or asserting where a server redirects. */
export function urlComponentExplanation(url: URL): string {
  const parts: string[] = [];
  if (url.pathname !== '/') {
    const names = hostnameText(decodeOnce(url.pathname));
    parts.push(names.length
      ? `The path contains hostname text (${names.join(', ')}); path text does not change the actual host.`
      : 'The path after the host does not identify a different website owner.');
  }
  if (url.search) {
    const names = new Set<string>();
    // Query keys such as password or token are deliberately not inspected for
    // display. Recognised navigation parameters still convey text, not behavior.
    for (const [key, value] of url.searchParams) {
      if (!REDIRECT_PARAMETER.test(key)) continue;
      for (const name of hostnameText(value)) if (names.size < 2) names.add(name);
    }
    parts.push(names.size
      ? `The query contains hostname text (${[...names].join(', ')}); query text does not change the actual host.`
      : 'Query text after ? does not change the actual host.');
    parts.push('A query parameter is not proof that a redirect occurs.');
  }
  if (url.hash) parts.push('Fragment text after # does not change the actual host.');
  parts.push('This check does not open the link or follow redirects; no final destination or website owner has been verified.');
  return parts.join(' ');
}

/** Explain an already-rejected IDN without treating every accented letter as
 * non-Latin, guessing a lookalike replacement, or displaying raw authority. */
export function internationalHostnameExplanation(authority: string): string {
  const decoded = decodeOnce(authority);
  const nonLatinLetter = [...decoded].some(character => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character));
  const description = nonLatinLetter
    ? 'The hostname contains a non-Latin letter and is encoded using Punycode (xn--).'
    : /[^\x00-\x7f]/.test(decoded)
      ? 'The hostname contains non-ASCII characters and is encoded using Punycode (xn--).'
      : 'This hostname uses Punycode (xn--) to encode international characters.';
  return `${description} Character lookalikes have not been assessed. It has not been matched to an organisation or sent for an external reputation lookup.`;
}
