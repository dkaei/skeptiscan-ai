import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareImage } from '../src/image';
import { assertRawImageDimensions, MAX_UPLOAD_BYTES, preflightImage } from '../src/imagePreflight';

const bytes = (...values: (Uint8Array | number[])[]) => Uint8Array.from(values.flatMap(value => [...value]));
const ascii = (value: string) => Uint8Array.from(value, letter => letter.charCodeAt(0));
const be32 = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; };
const le32 = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return out; };

// Structural fixtures deliberately omit real compressed pixels/CRCs. These test
// header screening; the real file fixtures below exercise supported file layouts.
function pngChunk(kind: string, payload = new Uint8Array()) {
  return bytes(be32(payload.length), ascii(kind), payload, [0, 0, 0, 0]);
}
function png(width: number, height: number, extra: Uint8Array[] = []) {
  return bytes([137, 80, 78, 71, 13, 10, 26, 10], pngChunk('IHDR', bytes(be32(width), be32(height), [8, 6, 0, 0, 0])), ...extra, pngChunk('IDAT', new Uint8Array([1])), pngChunk('IEND'));
}
function jpegSegment(marker: number, payload: Uint8Array) {
  const length = payload.length + 2;
  return bytes([0xff, marker, length >>> 8, length & 255], payload);
}
function jpegFrame(width: number, height: number, progressive = false) {
  return jpegSegment(progressive ? 0xc2 : 0xc0, new Uint8Array([8, height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0]));
}
const scan = () => bytes(jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])), [0x41, 0xff, 0x00, 0x42, 0xff, 0xd0, 0x43]);
function jpeg(width: number, height: number, progressive = false) {
  return bytes([0xff, 0xd8], jpegFrame(width, height, progressive), scan(), ...(progressive ? [scan()] : []), [0xff, 0xd9]);
}
function webpChunk(kind: string, payload: Uint8Array) {
  return bytes(ascii(kind), le32(payload.length), payload, payload.length & 1 ? [0] : []);
}
function riff(...chunks: Uint8Array[]) {
  const body = bytes(ascii('WEBP'), ...chunks);
  return bytes(ascii('RIFF'), le32(body.length), body);
}
function vp8(width: number, height: number) {
  return webpChunk('VP8 ', new Uint8Array([0x10, 0, 0, 0x9d, 1, 0x2a, width & 255, width >>> 8, height & 255, height >>> 8]));
}
function vp8l(width: number, height: number) {
  return webpChunk('VP8L', bytes([0x2f], le32((width - 1) | ((height - 1) << 14))));
}
function vp8x(width: number, height: number, flags = 0) {
  const w = width - 1, h = height - 1;
  return webpChunk('VP8X', new Uint8Array([flags, 0, 0, 0, w & 255, (w >>> 8) & 255, w >>> 16, h & 255, (h >>> 8) & 255, h >>> 16]));
}

afterEach(() => vi.unstubAllGlobals());

describe('bounded header preflight', () => {
  it.each([
    ['PNG', png(1080, 12000), 'image/png', 1080, 12000],
    ['baseline JPEG', jpeg(720, 16000), 'image/jpeg', 720, 16000],
    ['progressive JPEG with stuffed bytes/restarts', jpeg(1200, 2400, true), 'image/jpeg', 1200, 2400],
    ['lossy WebP', riff(vp8(1080, 1920)), 'image/webp', 1080, 1920],
    ['lossless WebP', riff(vp8l(1080, 1920)), 'image/webp', 1080, 1920],
    ['extended lossy WebP', riff(vp8x(1080, 1920), vp8(1080, 1920)), 'image/webp', 1080, 1920],
    ['extended lossless WebP with metadata', riff(vp8x(1080, 1920, 8), vp8l(1080, 1920), webpChunk('EXIF', new Uint8Array([1, 2, 3]))), 'image/webp', 1080, 1920],
  ] as const)('reads %s without decoding pixels', (_name, value, mime, width, height) => {
    expect(preflightImage(value, mime)).toEqual({ width, height });
  });

  it.each([
    ['screenshot.png', 'image/png'], ['screenshot.jpg', 'image/jpeg'],
    ['screenshot.webp', 'image/webp'], ['screenshot-exif-rotated.jpg', 'image/jpeg'],
  ])('accepts the existing real synthetic fixture %s', (name, mime) => {
    const value = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
    const result = preflightImage(value, mime);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('accepts the exact pixel ceiling and rejects either exceeded bound', () => {
    expect(() => assertRawImageDimensions(3000, 8000)).not.toThrow();
    expect(() => assertRawImageDimensions(1, 16000)).not.toThrow();
    expect(() => assertRawImageDimensions(3001, 8000)).toThrow(/too large/);
    expect(() => assertRawImageDimensions(1, 16001)).toThrow(/too large/);
    for (const value of [0, -1, NaN, Infinity, 1.5]) expect(() => assertRawImageDimensions(value, 2)).toThrow();
  });

  it.each([
    [png(0, 1), 'image/png'], [png(8000, 8000), 'image/png'],
    [jpeg(0, 1), 'image/jpeg'], [jpeg(16001, 1), 'image/jpeg'],
    [riff(vp8(0, 1)), 'image/webp'], [riff(vp8l(16001, 1)), 'image/webp'],
    [riff(vp8x(100, 100), vp8(8000, 8000)), 'image/webp'],
    [riff(vp8x(100, 100), vp8l(100, 101)), 'image/webp'],
    [riff(vp8x(100, 100)), 'image/webp'],
    [riff(vp8(100, 100), vp8(100, 100)), 'image/webp'],
    [riff(vp8x(100, 100), vp8x(100, 100), vp8(100, 100)), 'image/webp'],
    [bytes([0xff, 0xd8], jpegFrame(100, 100), scan(), jpegFrame(100, 101), scan(), [0xff, 0xd9]), 'image/jpeg'],
    [png(1, 1, [pngChunk('IHDR', bytes(be32(1), be32(1), [8, 6, 0, 0, 0]))]), 'image/png'],
  ] as const)('rejects unsafe, missing or contradictory dimensions (%#)', (value, mime) => {
    expect(() => preflightImage(value, mime)).toThrow();
  });

  it.each([
    [png(100, 100, [pngChunk('acTL', new Uint8Array(8))]), 'image/png'],
    [png(100, 100, [pngChunk('fcTL', new Uint8Array(26))]), 'image/png'],
    [riff(vp8x(100, 100, 2), vp8(100, 100)), 'image/webp'],
    [riff(vp8x(100, 100), webpChunk('ANMF', new Uint8Array(16)), vp8(100, 100)), 'image/webp'],
  ] as const)('rejects animated container declarations (%#)', (value, mime) => {
    expect(() => preflightImage(value, mime)).toThrow(/still screenshot/);
  });

  it.each([
    [png(2, 3), 'image/png'], [jpeg(2, 3), 'image/jpeg'], [riff(vp8x(2, 3), vp8l(2, 3)), 'image/webp'],
  ] as const)('rejects every truncated prefix, appended bytes and MIME mismatch (%#)', (value, mime) => {
    for (let length = 0; length < value.length; length++) expect(() => preflightImage(value.subarray(0, length), mime)).toThrow();
    expect(() => preflightImage(bytes(value, [0]), mime)).toThrow();
    expect(() => preflightImage(value, mime === 'image/png' ? 'image/jpeg' : 'image/png')).toThrow();
  });

  it('rejects malicious declared segment/chunk lengths without out-of-bounds reads', () => {
    const badPng = png(2, 3); new DataView(badPng.buffer).setUint32(8, 0xffffffff);
    const badJpeg = jpeg(2, 3); new DataView(badJpeg.buffer).setUint16(4, 0xffff);
    const badWebp = riff(vp8(2, 3)); new DataView(badWebp.buffer).setUint32(16, 0xffffffff, true);
    for (const [value, mime] of [[badPng, 'image/png'], [badJpeg, 'image/jpeg'], [badWebp, 'image/webp']] as const) {
      expect(() => preflightImage(value, mime)).toThrow(/incomplete or unsupported/);
    }
    expect(() => preflightImage(new Uint8Array(MAX_UPLOAD_BYTES + 1), 'image/png')).toThrow();
  });

  it('reads only the supplied view, including a nonzero byte offset', () => {
    const image = png(8, 9), padded = bytes([99, 98, 97], image, [96]);
    expect(preflightImage(padded.subarray(3, 3 + image.length), 'image/png')).toEqual({ width: 8, height: 9 });
  });
});

function file(value: Uint8Array, mime = 'image/png') {
  return new File([Uint8Array.from(value).buffer], 'synthetic-screenshot', { type: mime });
}
function mockPreparation(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const output = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: vi.fn((callback: BlobCallback) => callback(output)) };
  const createObjectURL = vi.fn(() => 'blob:synthetic-preview');
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  vi.stubGlobal('URL', { createObjectURL });
  return { bitmap, decode, canvas, createObjectURL, context };
}

describe('preparation guards run before browser decoding', () => {
  it.each([
    ['over pixel budget', png(8000, 8000), 'image/png'],
    ['over edge budget', jpeg(16001, 1), 'image/jpeg'],
    ['mismatched WebP dimensions', riff(vp8x(20, 20), vp8l(30, 30)), 'image/webp'],
    ['truncated image', png(20, 20).subarray(0, 34), 'image/png'],
    ['animation', riff(vp8x(20, 20, 2), vp8(20, 20)), 'image/webp'],
  ] as const)('never dispatches %s to the decoder', async (_name, value, mime) => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(prepareImage(file(value, mime))).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it('retains normal output, local preview and bitmap cleanup', async () => {
    const mocks = mockPreparation(320, 180);
    const output = await prepareImage(file(png(320, 180)));
    expect(mocks.decode).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' });
    expect(output).toMatchObject({ width: 320, height: 180, mimeType: 'image/jpeg', preview: 'blob:synthetic-preview' });
    expect(mocks.createObjectURL).toHaveBeenCalledOnce();
    expect(mocks.bitmap.close).toHaveBeenCalledOnce();
  });

  it('preserves EXIF rotation and bounds normalized tall screenshots', async () => {
    const mocks = mockPreparation(180, 320);
    expect(await prepareImage(file(jpeg(320, 180), 'image/jpeg'))).toMatchObject({ width: 180, height: 320 });
    expect(mocks.bitmap.close).toHaveBeenCalledOnce();
    const tall = mockPreparation(1080, 12000);
    const output = await prepareImage(file(png(1080, 12000)));
    expect(output.height).toBe(4096);
    expect(output.width * output.height).toBeLessThanOrEqual(6_000_000);
    expect(tall.bitmap.close).toHaveBeenCalledOnce();
  });

  it.each([[8000, 8000], [320, 181], [0, 180]])('rejects unexpected decoded dimensions %sx%s and closes the bitmap', async (width, height) => {
    const mocks = mockPreparation(width, height);
    await expect(prepareImage(file(png(320, 180)))).rejects.toThrow();
    expect(mocks.canvas.getContext).not.toHaveBeenCalled();
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.bitmap.close).toHaveBeenCalledOnce();
  });

  it('does not treat header acceptance as successful decoding', async () => {
    const decode = vi.fn().mockRejectedValue(new Error('Synthetic decoder rejection'));
    vi.stubGlobal('createImageBitmap', decode);
    await expect(prepareImage(file(png(2, 3)))).rejects.toThrow('This image could not be opened.');
    expect(decode).toHaveBeenCalledOnce();
  });

  it('closes the bitmap if normalization cannot produce output', async () => {
    const mocks = mockPreparation(320, 180);
    mocks.canvas.toBlob.mockImplementation(callback => callback(null));
    await expect(prepareImage(file(png(320, 180)))).rejects.toThrow(/too large to prepare/);
    expect(mocks.canvas.toBlob).toHaveBeenCalledTimes(5);
    expect(mocks.bitmap.close).toHaveBeenCalledOnce();
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });
});
