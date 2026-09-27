import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import type { CheckInput } from '../shared/contracts';
import type { Env } from '../server/types';
import { ServiceError } from '../server/types';
import { MAX_IMAGE_BYTES, normalizeImage, screenImage } from '../server/images';

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, payload = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type), payload]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** Default is a valid transparent 1px PNG. Other sizes test header screening only. */
function png(width = 1, height = 1, ancillary: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    ...ancillary, pngChunk('IDAT', deflateSync(Buffer.alloc(5))), pngChunk('IEND'),
  ]);
}
function webpChunk(type: string, payload: Buffer, padded = true): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from(type), length, payload, ...(padded && payload.length % 2 ? [Buffer.alloc(1)] : [])]);
}
/** Synthetic RIFF headers test screening, never stand in for a real decoder. */
function webp(width = 1, height = 1, flags = 0, extra: Buffer[] = []): Buffer {
  const extended = Buffer.alloc(10); extended[0] = flags;
  extended.writeUIntLE(width - 1, 4, 3); extended.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), webpChunk('VP8X', extended), ...extra]);
  const length = Buffer.alloc(4); length.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), length, body]);
}
function jpeg(width = 1, height = 1): Buffer {
  const dimensions = Buffer.alloc(11);
  dimensions.writeUInt16BE(11); dimensions[2] = 8;
  dimensions.writeUInt16BE(height, 3); dimensions.writeUInt16BE(width, 5);
  dimensions[7] = 1; dimensions[8] = 1; dimensions[9] = 0x11;
  return Buffer.concat([Buffer.from([255, 216, 255, 192]), dimensions, Buffer.from([255, 218, 0, 2, 0, 255, 217])]);
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const imageInput = (bytes = png(), mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png'): CheckInput => ({
  mode: 'screenshot', content: '', context: '', senderEmail: '', senderPhone: '', externalLookup: false,
  image: { base64: b64(bytes), mimeType },
});
const errorShape = { code: 'invalid_image', status: 422, field: 'image' };
function expectInvalid(bytes: Uint8Array, mimeType = 'image/png'): void {
  expect(() => screenImage(b64(bytes), mimeType)).toThrowError(ServiceError);
  try { screenImage(b64(bytes), mimeType); } catch (error) { expect(error).toMatchObject(errorShape); }
}
async function readAll(source: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = source.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
function mockImages(options: { outputBytes?: Uint8Array; info?: ImageInfoResponse; chunks?: Uint8Array[] } = {}) {
  const sourceForInfo: Buffer[] = [];
  const sourceForTransform: Promise<Buffer>[] = [];
  const cancelled = vi.fn();
  const outputBytes = options.outputBytes ?? png();
  const info = vi.fn(async (source: ReadableStream<Uint8Array>) => {
    sourceForInfo.push(await readAll(source));
    return options.info ?? { format: 'image/png', fileSize: png().length, width: 1, height: 1 };
  });
  const output = vi.fn(async (_settings: ImageOutputOptions) => ({
    image: () => new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of options.chunks ?? [outputBytes]) controller.enqueue(chunk); },
      pull(controller) { controller.close(); },
      cancel: cancelled,
    }),
  }));
  const transformer = { transform: vi.fn((_settings: ImageTransform) => transformer), output };
  const input = vi.fn((source: ReadableStream<Uint8Array>) => {
    sourceForTransform.push(readAll(source));
    return transformer;
  });
  const env = { IMAGES: { info, input } } as unknown as Env;
  return { env, info, input, output, transform: transformer.transform, sourceForInfo, sourceForTransform, cancelled };
}

describe('image header screening', () => {
  it.each(['', 'a', '%%%%', 'YW Jj', 'data:image/png;base64,AAAA', 'AAAA\n'])('rejects malformed base64 %j', value => {
    expect(() => screenImage(value, 'image/png')).toThrowError(ServiceError);
  });
  it('rejects the upload byte limit with a controlled image error', () => {
    expectInvalid(Buffer.alloc(MAX_IMAGE_BYTES + 1));
  });
  it.each([
    ['image/jpeg', png()], ['image/webp', png()], ['image/png', jpeg()], ['image/svg+xml', Buffer.from('<svg/>')],
  ])('rejects a declared MIME that does not match the screened bytes (%s)', (mime, bytes) => {
    expectInvalid(bytes, mime);
  });
  it('accepts the header and full chunk boundaries of a valid still PNG', () => {
    const bytes = png();
    expect(Buffer.from(screenImage(b64(bytes), 'image/png'))).toEqual(bytes);
  });
  it.each([[0, 1], [1, 0], [4097, 1], [1, 4097], [3000, 2001]])('rejects PNG dimensions %s × %s', (width, height) => {
    expectInvalid(png(width, height));
  });
  it('allows exactly the pixel ceiling at the screening stage', () => {
    expect(() => screenImage(b64(png(3000, 2000)), 'image/png')).not.toThrow();
  });
  it('rejects APNG even though the first frame looks like PNG', () => {
    expectInvalid(png(1, 1, [pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))]));
  });
  it('rejects data after PNG IEND and a missing IEND', () => {
    expectInvalid(Buffer.concat([png(), Buffer.from('trailing payload')]));
    expectInvalid(png().subarray(0, -12));
  });
  it('rejects a PNG chunk whose declared length runs past the file', () => {
    const bytes = png(); new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(33, 0x7fffffff);
    expectInvalid(bytes);
  });
  it('screens JPEG dimensions and end marker without pretending to decode pixels', () => {
    expect(() => screenImage(b64(jpeg()), 'image/jpeg')).not.toThrow();
    expectInvalid(jpeg(4097, 1), 'image/jpeg');
    expectInvalid(jpeg().subarray(0, -2), 'image/jpeg');
    expectInvalid(Buffer.from([255, 216, 0, 0, 0, 0, 0, 0, 255, 217]), 'image/jpeg');
  });
  it('rejects extended-WebP animation flags and animation frame chunks', () => {
    expectInvalid(webp(1, 1, 2), 'image/webp');
    expectInvalid(webp(1, 1, 0, [webpChunk('ANMF', Buffer.alloc(0))]), 'image/webp');
    expectInvalid(webp(1, 1, 0, [webpChunk('ANIM', Buffer.alloc(6))]), 'image/webp');
  });
  it('rejects WebP dimension and RIFF length violations', () => {
    expectInvalid(webp(4097, 1), 'image/webp');
    const bytes = webp(); new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(4, bytes.length + 50, true);
    expectInvalid(bytes, 'image/webp');
  });
  it('rejects trailing WebP bytes and absent padding for odd-length chunks', () => {
    expectInvalid(webp(1, 1, 0, [Buffer.from([0])]), 'image/webp');
    expectInvalid(webp(1, 1, 0, [webpChunk('EXIF', Buffer.from([1]), false)]), 'image/webp');
  });
});

describe('decode and normalise boundary', () => {
  it('returns text input unchanged without calling image services', async () => {
    const images = mockImages();
    const text: CheckInput = { mode: 'message', content: 'Hello', context: '', senderEmail: '', senderPhone: '', externalLookup: false };
    expect(await normalizeImage(text, images.env, new AbortController().signal)).toBe(text);
    expect(images.info).not.toHaveBeenCalled();
  });
  it('reports unavailable rather than sending the original upload to a model', async () => {
    await expect(normalizeImage(imageInput(), {} as Env, new AbortController().signal)).rejects.toMatchObject({ code: 'images_unavailable', status: 503, field: 'image' });
  });
  it('rejects a pre-aborted request before either decoder call', async () => {
    const images = mockImages();
    await expect(normalizeImage(imageInput(), images.env, AbortSignal.abort())).rejects.toBeDefined();
    expect(images.info).not.toHaveBeenCalled();
    expect(images.input).not.toHaveBeenCalled();
  });
  it('screens invalid uploads before sending bytes to the image binding', async () => {
    const images = mockImages();
    await expect(normalizeImage(imageInput(Buffer.from('not an image')), images.env, new AbortController().signal)).rejects.toMatchObject(errorShape);
    expect(images.info).not.toHaveBeenCalled();
    expect(images.input).not.toHaveBeenCalled();
  });
  it.each([
    { format: 'image/svg+xml' } as ImageInfoResponse,
    { format: 'image/png', fileSize: 20, width: 5000, height: 1 },
    { format: 'image/png', fileSize: 20, width: 3000, height: 3000 },
    { format: 'image/png', fileSize: 20, width: 0, height: 100 },
    { format: 'image/png', fileSize: 20, width: 1.5, height: 100 },
  ])('rejects unsupported decoder output or decoded dimensions: %j', async info => {
    const images = mockImages({ info });
    await expect(normalizeImage(imageInput(), images.env, new AbortController().signal)).rejects.toMatchObject(errorShape);
    expect(images.input).not.toHaveBeenCalled();
  });
  it('rejects a decoded media type that disagrees with the declared type', async () => {
    const images = mockImages({ info: { format: 'image/jpeg', fileSize: 20, width: 1, height: 1 } });
    await expect(normalizeImage(imageInput(), images.env, new AbortController().signal)).rejects.toMatchObject(errorShape);
    expect(images.input).not.toHaveBeenCalled();
  });
  it('requires decode and re-encode, limits size and returns only the produced PNG', async () => {
    const original = imageInput(jpeg(), 'image/jpeg');
    const clean = png();
    const images = mockImages({ outputBytes: clean, info: { format: 'image/jpeg', fileSize: jpeg().length, width: 1, height: 1 } });
    const result = await normalizeImage(original, images.env, new AbortController().signal);
    expect(images.sourceForInfo).toEqual([jpeg()]);
    expect(await images.sourceForTransform[0]).toEqual(jpeg());
    expect(images.transform).toHaveBeenCalledWith(expect.objectContaining({ width: 2560, height: 2560, fit: 'scale-down' }));
    expect(images.output).toHaveBeenCalledWith(expect.objectContaining({ format: 'image/png', anim: false }));
    expect(result.image).toEqual({ base64: b64(clean), mimeType: 'image/png' });
    expect(result).not.toBe(original);
    expect(original.image?.mimeType).toBe('image/jpeg');
  });
  it('strips potentially identifying PNG metadata even if the image service returns it', async () => {
    const withMetadata = png(1, 1, [
      pngChunk('tEXt', Buffer.from('Author\0Private Person')),
      pngChunk('iTXt', Buffer.from('Comment\0\0\0\0\0Private location')),
      pngChunk('eXIf', Buffer.from('II*\0Private GPS data')),
      pngChunk('zTXt', Buffer.concat([Buffer.from('Description\0\0'), deflateSync('Private account name')])),
    ]);
    const images = mockImages({ outputBytes: withMetadata });
    const result = await normalizeImage(imageInput(withMetadata), images.env, new AbortController().signal);
    const normalized = Buffer.from(result.image!.base64, 'base64');
    expect(normalized).toEqual(png());
    expect(normalized.includes(Buffer.from('Private'))).toBe(false);
    expect(() => screenImage(result.image!.base64, result.image!.mimeType)).not.toThrow();
  });
  it('rejects a transformation that returns malformed or animated bytes', async () => {
    for (const outputBytes of [Buffer.from('not a PNG'), png(1, 1, [pngChunk('acTL', Buffer.alloc(8))])]) {
      const images = mockImages({ outputBytes });
      await expect(normalizeImage(imageInput(), images.env, new AbortController().signal)).rejects.toMatchObject(errorShape);
    }
  });
  it('caps streamed output bytes and cancels further reading', async () => {
    const images = mockImages({ chunks: [new Uint8Array(MAX_IMAGE_BYTES), new Uint8Array(1), new Uint8Array(1)] });
    await expect(normalizeImage(imageInput(), images.env, new AbortController().signal)).rejects.toMatchObject(errorShape);
    expect(images.cancelled).toHaveBeenCalledTimes(1);
  });
  it('does not expose decoder errors or their embedded content', async () => {
    const images = mockImages();
    images.info.mockRejectedValue(new Error('secret original image data or provider details'));
    const operation = normalizeImage(imageInput(), images.env, new AbortController().signal);
    await expect(operation).rejects.toMatchObject({ code: 'image_processing', status: 422, field: 'image' });
    await expect(operation).rejects.not.toThrow('secret original');
    expect(images.input).not.toHaveBeenCalled();
  });
  it('does not start a transform after cancellation during image information decoding', async () => {
    const controller = new AbortController();
    const images = mockImages();
    images.info.mockImplementation(async () => {
      controller.abort();
      return { format: 'image/png', fileSize: 20, width: 1, height: 1 };
    });
    await expect(normalizeImage(imageInput(), images.env, controller.signal)).rejects.toBeDefined();
    expect(images.input).not.toHaveBeenCalled();
  });
});
