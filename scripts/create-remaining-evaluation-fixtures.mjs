// Synthetic fixture creation only. No network, accounts, application or model calls.
// Refuses to overwrite existing fixture files or the completion manifest.
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../evaluation/fixtures/', import.meta.url);
const proof = new URL('../verification/evaluation-completion-2026-09-27/', import.meta.url);
const referenceUrl = new URL('../evaluation/screenshot-specs-v1.json', import.meta.url);
const existingManifestUrl = new URL('manifest.json', output);
const manifestUrl = new URL('manifest-completion-2026-09-27.json', output);
const referenceBytes = await readFile(referenceUrl);
const specs = JSON.parse(referenceBytes.toString('utf8'));
const existingManifestBytes = await readFile(existingManifestUrl);
const existingManifest = JSON.parse(existingManifestBytes.toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeXml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const normalizeText = text => text.replace(/\s+/g, ' ').trim();
const fontPath = 'C:/Windows/Fonts/arial.ttf';
const fontBytes = await readFile(fontPath);
const width = 600, height = 650, fontSize = 24, fontFamily = 'Arial';
const originalHashes = {};
for (const entry of existingManifest.fixtures) {
  const actual = sha256(await readFile(new URL(entry.file, output)));
  if (actual !== entry.sha256) throw new Error(`Existing fixture changed: ${entry.id}`);
  originalHashes[entry.file] = actual;
}
originalHashes['manifest.json'] = sha256(existingManifestBytes);
originalHashes['../screenshot-specs-v1.json'] = sha256(referenceBytes);

const plans = [
  {
    id: 'S03', title: 'COMMUNITY UPDATE', panelHeight: 415,
    texts: [
      { text: 'Read public information at', x: 48, y: 169 },
      { text: 'https://www.gov.sg/', x: 48, y: 211 },
      { text: 'To reserve your allocation,', x: 48, y: 287 },
      { text: 'transfer S$90 now to my', x: 48, y: 329 },
      { text: 'personal account.', x: 48, y: 371 },
      { text: 'The public information page is', x: 48, y: 447 },
      { text: 'proof you can trust me.', x: 48, y: 489 },
    ],
  },
  {
    id: 'S05', title: 'MESSAGE', panelHeight: 235,
    texts: [
      { text: 'Send the login code to me', x: 48, y: 177 },
      { text: 'in this chat.', x: 48, y: 219 },
      { text: 'I will take care of the rest.', x: 48, y: 300 },
    ],
  },
  {
    id: 'S07', title: 'DELIVERY MESSAGE', panelHeight: 235,
    extraShape: '<rect x="48" y="231" width="456" height="68" rx="13" fill="#e7ecf3" stroke="#c8d2df"/>',
    texts: [
      { text: 'Your delivery update is ready.', x: 48, y: 180 },
      { text: 'View in delivery app', x: 276, y: 273, anchor: 'middle' },
    ],
    renderNote: 'Square brackets in renderText describe a button boundary. The visible label is rendered inside a rounded rectangle; there are no hyperlink targets or destinations in the SVG or pixels.',
  },
  {
    id: 'S08', title: 'CHAT', panelHeight: 400,
    texts: [
      { text: 'Eh my phone spoilt lah, this is', x: 48, y: 177 },
      { text: 'my new number.', x: 48, y: 219 },
      { text: 'Can transfer S$120 to my', x: 48, y: 298 },
      { text: 'colleague first? I pay you back', x: 48, y: 340 },
      { text: 'tonight.', x: 48, y: 382 },
      { text: "Don't call, in meeting now.", x: 48, y: 461 },
    ],
  },
];

// Check every destination before any write, then still use exclusive creation.
for (const url of [...plans.map(item => new URL(`${item.id}.png`, output)), manifestUrl]) {
  let exists = false;
  try { await access(url); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error(`Refusing to overwrite ${fileURLToPath(url)}`);
}
await mkdir(output, { recursive: true });
await mkdir(proof, { recursive: true });

const entries = [];
const oldS02 = existingManifest.fixtures.find(item => item.id === 'S02');
const s02Spec = specs.cases.find(item => item.id === 'S02');
entries.push({
  id: 'S02', file: oldS02.file, fileCreatedInThisBatch: false,
  sha256: oldS02.sha256, byteLength: oldS02.byteLength,
  width: oldS02.width, height: oldS02.height, mimeType: oldS02.mimeType,
  literalVisibleText: oldS02.literalVisibleText, textRuns: oldS02.textRuns,
  crop: oldS02.crop, blur: oldS02.blur,
  inputOverrides: s02Spec.inputOverrides, inputWithoutImage: { ...specs.defaultInput, ...s02Spec.inputOverrides },
  pixelReference: s02Spec.pixelReference, expected: s02Spec.expected,
  transportRequirement: 'Preserve the separate context exactly; do not run the fixture without it merely because the screenshot UI lacks a context field.',
  aiVisualReview: { status: 'pending_current_preflight', humanReviewed: false },
});

for (const plan of plans) {
  const spec = specs.cases.find(item => item.id === plan.id);
  if (!spec) throw new Error(`Unknown reference ${plan.id}`);
  const textRuns = [{ text: plan.title, x: 38, y: 64, size: 26 }, ...plan.texts];
  const expectedText = plan.id === 'S07' ? spec.renderText.replace('[ View in delivery app ]', 'View in delivery app') : spec.renderText;
  if (normalizeText(textRuns.map(run => run.text).join(' ')) !== normalizeText(expectedText)) {
    throw new Error(`Visible text differs from the frozen reference: ${plan.id}`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="${width}" height="${height}" fill="#f4f6f8"/>
<rect width="${width}" height="101" fill="#ffffff"/>
<line x1="0" y1="101" x2="600" y2="101" stroke="#d7dee4"/>
<rect x="28" y="122" width="544" height="${plan.panelHeight}" rx="18" fill="#ffffff" stroke="#d7dee4"/>
${plan.extraShape ?? ''}
<g font-family="${fontFamily}" fill="#202b35" font-size="${fontSize}">
${textRuns.map(run => `<text x="${run.x}" y="${run.y}"${run.size ? ` font-size="${run.size}"` : ''}${run.anchor ? ` text-anchor="${run.anchor}"` : ''}>${escapeXml(run.text)}</text>`).join('\n')}
</g></svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  const file = `${plan.id}.png`;
  await writeFile(new URL(file, output), png, { flag: 'wx' });
  entries.push({
    id: plan.id, file, fileCreatedInThisBatch: true, sha256: sha256(png), byteLength: png.length,
    width, height, mimeType: 'image/png',
    literalVisibleText: textRuns.map(run => run.text),
    textRuns: textRuns.map(run => ({ ...run, fontFamily, fontSizePx: run.size ?? fontSize })),
    crop: null, blur: null, obscuration: null,
    ...(plan.renderNote ? { renderNote: plan.renderNote } : {}),
    inputOverrides: spec.inputOverrides, inputWithoutImage: { ...specs.defaultInput, ...spec.inputOverrides },
    pixelReference: spec.pixelReference, expected: spec.expected,
    ...(plan.id === 'S05' ? { transportRequirement: 'Submit the conflicting content override exactly alongside the image. The contradiction is part of the test; never replace the pixel text or omit the correction.' } : {}),
    ...(plan.id === 'S07' ? { transportRequirement: 'Preserve the separate context exactly. The destination is absent, not obscured; never add a URL inferred from the button label.' } : {}),
    aiVisualReview: { status: 'pending', humanReviewed: false },
  });
}

// Ensure older pixels, their manifest and the reference were not modified.
for (const [file, originalHash] of Object.entries(originalHashes)) {
  if (sha256(await readFile(new URL(file, output))) !== originalHash) throw new Error(`Preservation check failed: ${file}`);
}
const manifest = {
  version: 'skeptiscan-screenshot-fixtures-completion-2026-09-27',
  createdAt: new Date().toISOString(), generatedBy: 'scripts/create-remaining-evaluation-fixtures.mjs',
  referenceFile: '../screenshot-specs-v1.json', referenceSha256: sha256(referenceBytes),
  status: 'pixels_created_ai_preflight_pending', humanReviewed: false, modelOutputsSeen: false,
  font: { family: fontFamily, sourcePath: fontPath, sourceSha256: sha256(fontBytes), rendering: 'SVG text through Sharp/libvips on this Windows host; Arial available as a system font.' },
  renderer: { sharp: sharp.versions.sharp, vips: sharp.versions.vips, svg: sharp.versions.rsvg },
  preservedOriginalHashes: originalHashes,
  limitations: [
    'Five remaining scenarios only: existing S02 plus new S03/S05/S07/S08. No model call or application run performed by this generator.',
    'Synthetic fictional panels without real conversations, code values, personal contacts or account identifiers.',
    'Human-reviewed remains false. AI pixel inspection cannot establish human comprehension or accessibility.',
    'All input/context overrides are copied verbatim from the frozen reference, not rewritten for UI convenience.',
    'S03 contains a public government homepage as literal screenshot text only. It is not visited, and no sender or transaction is authenticated.',
    'S07 contains a drawn button only. There is no target URL in the SVG, PNG or input.',
    'The original files and original manifest remain unchanged. This separate manifest does not retrospectively change their historical status.',
  ],
  fixtures: entries.sort((a, b) => a.id.localeCompare(b.id)),
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(manifestUrl, serialized, { flag: 'wx' });
await writeFile(new URL('screenshot-fixtures-manifest.json', proof), serialized, { flag: 'wx' });
console.log(JSON.stringify({ manifest: fileURLToPath(manifestUrl), fixtures: entries.map(({ id, file, sha256, byteLength }) => ({ id, file, sha256, byteLength })), preservedOriginalHashes: originalHashes }, null, 2));
