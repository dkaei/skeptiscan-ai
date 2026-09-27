import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { screenImage, MAX_IMAGE_BYTES } from '../server/images';

// The actual application runs in workerd. Miniflare's local Images binding uses
// Sharp/libvips, not the production Cloudflare decoder. All outbound fetches fail.
let runtime: Miniflare;
const outbound: string[] = [];
let screenshot: Buffer;
type ImageResult = { ok: true; image: { base64: string; mimeType: string } } | { ok: false; code: string };

beforeAll(async () => {
  screenshot = await readFile(new URL('./fixtures/screenshot.png', import.meta.url));
  const bundle = await build({
    stdin: { contents: `
      import { normalizeImage } from './server/images';
      export default { async fetch(request, env) {
        const image = await request.json();
        try {
          const output = await normalizeImage({ mode:'screenshot',content:'',context:'',senderEmail:'',senderPhone:'',externalLookup:false,image }, env, new AbortController().signal);
          return Response.json({ok:true,image:output.image});
        } catch(error) { return Response.json({ok:false,code:error.code ?? 'unexpected'}); }
      }};
    `, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    conditions: ['workerd', 'browser'], external: ['node:*'], logLevel: 'silent',
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: 'offline-images-normalization', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'],
    images: { binding: 'IMAGES' },
    outboundService: async request => { outbound.push(request.url); return new Response('Network disabled in image tests', { status: 503 }); },
  }));
}, 20_000);

afterAll(async () => {
  try { expect(outbound).toEqual([]); }
  finally { await runtime?.dispose(); }
});

async function normalize(bytes: Uint8Array, mimeType: string): Promise<ImageResult> {
  const response = await runtime.dispatchFetch('http://localhost/normalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64: Buffer.from(bytes).toString('base64'), mimeType }),
  });
  return await response.json() as ImageResult;
}

async function normalizedPng(bytes: Uint8Array, mimeType: string): Promise<Buffer> {
  const result = await normalize(bytes, mimeType);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(result.image.mimeType).toBe('image/png');
  const output = Buffer.from(result.image.base64, 'base64');
  expect(output.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  expect(() => screenImage(result.image.base64, result.image.mimeType)).not.toThrow();
  // Actually decode the output pixels, not only their format/dimension headers.
  await sharp(output).raw().toBuffer();
  return output;
}

function chunks(png: Uint8Array): { name: string; bytes: Uint8Array; data: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const result = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = view.getUint32(offset);
    result.push({ name: Buffer.from(png.subarray(offset + 4, offset + 8)).toString('ascii'), bytes: png.subarray(offset, offset + size + 12), data: png.subarray(offset + 8, offset + size + 8) });
    offset += size + 12;
  }
  return result;
}

function chunk(name: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.length + 12), view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(new TextEncoder().encode(name), 4);
  output.set(data, 8);
  let crc = 0xffffffff;
  for (const value of output.subarray(4, output.length - 4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0);
  return output;
}

describe('real workerd normalizeImage with the local Images decoder', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes and re-encodes a synthetic %s screenshot into bounded PNG', async format => {
    const input = format === 'png' ? screenshot : await sharp(screenshot).toFormat(format).toBuffer();
    const output = await normalizedPng(input, `image/${format}`);
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 600, height: 650 });
  });

  it('strips a valid PNG text metadata chunk while preserving decoded screenshot pixels', async () => {
    const marker = 'SYNTHETIC_METADATA_SENTINEL';
    const parts = chunks(screenshot);
    const input = Buffer.concat([screenshot.subarray(0, 8), parts[0].bytes, chunk('tEXt', new TextEncoder().encode(`Comment\0${marker}`)), ...parts.slice(1).map(part => part.bytes)]);
    expect(input.includes(Buffer.from(marker))).toBe(true);
    const output = await normalizedPng(input, 'image/png');
    expect(chunks(output).map(part => part.name)).not.toEqual(expect.arrayContaining(['tEXt']));
    expect(chunks(output).every(part => !['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(part.name))).toBe(true);
    expect(output.includes(Buffer.from(marker))).toBe(false);
    expect(await sharp(output).removeAlpha().raw().toBuffer()).toEqual(await sharp(screenshot).removeAlpha().raw().toBuffer());
  });

  it('decodes a permitted large raster and scales its longest edge to 2560 without enlarging the other dimension', async () => {
    const input = await sharp({ create: { width: 3200, height: 1000, channels: 3, background: '#e9edf5' } }).png().toBuffer();
    const output = await normalizedPng(input, 'image/png');
    expect(await sharp(output).metadata()).toMatchObject({ width: 2560, height: 800 });
  });

  it('rejects corrupt PNG CRC after it passes the bounded header screen', async () => {
    const input = Uint8Array.from(screenshot);
    input[29] ^= 0xff; // IHDR CRC byte, with signature, dimensions and chunk lengths intact.
    expect(() => screenImage(Buffer.from(input).toString('base64'), 'image/png')).not.toThrow();
    expect(await normalize(input, 'image/png')).toEqual({ ok: false, code: 'image_processing' });
  });

  it('rejects truncated compressed pixels despite intact PNG dimensions, chunk boundaries and CRCs', async () => {
    const parts = chunks(screenshot);
    const compressed = Buffer.concat(parts.filter(part => part.name === 'IDAT').map(part => part.data));
    const input = Buffer.concat([screenshot.subarray(0, 8), parts.find(part => part.name === 'IHDR')!.bytes,
      chunk('IDAT', compressed.subarray(0, Math.floor(compressed.length / 2))), chunk('IEND', new Uint8Array())]);
    expect(() => screenImage(input.toString('base64'), 'image/png')).not.toThrow();
    expect(await normalize(input, 'image/png')).toEqual({ ok: false, code: 'image_processing' });
  });

  it('records the local simulator limitation: it strips EXIF orientation without auto-rotating raw JPEG pixels', async () => {
    const input = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#e9edf5' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await sharp(input).metadata()).toMatchObject({ width: 320, height: 180, orientation: 6 });
    const output = await normalizedPng(input, 'image/jpeg');
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ width: 320, height: 180 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });
});
