import type { CheckInput } from '../shared/contracts';
import type { Env } from './types';
import { ServiceError } from './types';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 6_000_000;
const MAX_EDGE = 4096;
function invalid(message = 'Choose a valid PNG, JPG or WebP screenshot.'): never { throw new ServiceError('invalid_image', message, 422, 'image'); }
function sizeAllowed(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) invalid('This screenshot is too large. Crop it to the relevant message.');
}
const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

/** Screening only. The Images binding must still decode and re-encode these bytes. */
export function screenImage(base64: string, mimeType: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || !base64.length) invalid();
  const decodedLength = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (decodedLength > MAX_IMAGE_BYTES) invalid('This screenshot is too large. Crop it or choose a smaller image.');
  const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return screenImageBytes(data, mimeType);
}

/** Apply the same format guards to decoded uploads and the image service's output. */
function screenImageBytes(data: Uint8Array, mimeType: string): Uint8Array {
  if (data.byteLength > MAX_IMAGE_BYTES) invalid('This screenshot is too large. Crop it or choose a smaller image.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mimeType === 'image/png') {
    if (data.length < 33 || data[0] !== 137 || ascii(data, 1, 3) !== 'PNG' || data[4] !== 13 || data[5] !== 10 || data[6] !== 26 || data[7] !== 10 || ascii(data, 12, 4) !== 'IHDR' || view.getUint32(8) !== 13) invalid();
    sizeAllowed(view.getUint32(16), view.getUint32(20));
    let position = 8;
    let ended = false;
    while (position + 12 <= data.length) {
      const length = view.getUint32(position);
      if (length > data.length - position - 12) invalid();
      const kind = ascii(data, position + 4, 4);
      if (kind === 'acTL') invalid('Choose a still screenshot, not an animation.');
      position += length + 12;
      if (kind === 'IEND') { ended = true; break; }
    }
    if (!ended || position !== data.length) invalid();
  } else if (mimeType === 'image/jpeg') {
    if (data.length < 10 || data[0] !== 255 || data[1] !== 216 || data[data.length - 2] !== 255 || data[data.length - 1] !== 217) invalid();
    let position = 2;
    let found = false;
    while (position + 4 < data.length) {
      if (data[position] !== 255) invalid();
      while (data[position] === 255) position++;
      const marker = data[position++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > data.length) invalid();
      const length = view.getUint16(position);
      if (length < 2 || position + length > data.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) invalid();
        sizeAllowed(view.getUint16(position + 5), view.getUint16(position + 3));
        found = true;
      }
      position += length;
    }
    if (!found) invalid();
  } else if (mimeType === 'image/webp') {
    if (data.length < 30 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== data.length) invalid();
    const kind = ascii(data, 12, 4);
    if (kind === 'VP8X') {
      if (data[20] & 2) invalid('Choose a still screenshot, not an animation.');
      sizeAllowed(1 + data[24] + (data[25] << 8) + (data[26] << 16), 1 + data[27] + (data[28] << 8) + (data[29] << 16));
    } else if (kind === 'VP8 ') {
      if (ascii(data, 23, 3) !== '\x9d\x01\x2a') invalid();
      sizeAllowed(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    } else if (kind === 'VP8L') {
      if (data[20] !== 0x2f) invalid();
      const bits = view.getUint32(21, true);
      sizeAllowed((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else invalid();
    let p = 12;
    for (; p + 8 <= data.length;) {
      const length = view.getUint32(p + 4, true);
      if (length > data.length - p - 8) invalid();
      if (['ANIM', 'ANMF'].includes(ascii(data, p, 4))) invalid('Choose a still screenshot, not an animation.');
      p += 8 + length + (length % 2);
    }
    if (p !== data.length) invalid();
  } else invalid();
  return data;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
async function boundedBytes(streamValue: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = streamValue.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_IMAGE_BYTES) { await reader.cancel(); invalid('Crop this screenshot to the message you want to check.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
/** Remove textual/EXIF metadata after the trusted decoder has produced a PNG. */
function stripMetadata(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [bytes.subarray(0, 8)];
  for (let position = 8; position + 12 <= bytes.length;) {
    const length = view.getUint32(position) + 12;
    const kind = ascii(bytes, position + 4, 4);
    if (!['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(kind)) chunks.push(bytes.subarray(position, position + length));
    position += length;
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
export async function normalizeImage(input: CheckInput, env: Env, signal: AbortSignal): Promise<CheckInput> {
  if (!input.image) return input;
  if (!env.IMAGES) throw new ServiceError('images_unavailable', 'Screenshot analysis is not connected yet. You can paste the message instead.', 503, 'image');
  signal.throwIfAborted();
  const bytes = screenImage(input.image.base64, input.image.mimeType);
  try {
    const info = await env.IMAGES.info(stream(bytes));
    signal.throwIfAborted();
    if (!('width' in info)) invalid();
    const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[input.image.mimeType];
    if (![expected, input.image.mimeType].includes(info.format)) invalid();
    sizeAllowed(info.width, info.height);
    const result = await env.IMAGES.input(stream(bytes)).transform({ width: 2560, height: 2560, fit: 'scale-down' }).output({ format: 'image/png', anim: false });
    signal.throwIfAborted();
    const normalized = await boundedBytes(result.image());
    signal.throwIfAborted();
    screenImageBytes(normalized, 'image/png');
    const base64 = encode(stripMetadata(normalized));
    return { ...input, image: { base64, mimeType: 'image/png' } };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('image_processing', 'This screenshot could not be prepared. Try a clearer crop or paste the message.', 422, 'image');
  }
}
