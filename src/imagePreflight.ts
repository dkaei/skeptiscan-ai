export interface ImageDimensions { width: number; height: number }
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_RAW_PIXELS = 24_000_000;
export const MAX_RAW_EDGE = 16_000;

function invalid(): never {
  throw new Error('This image is incomplete or unsupported. Choose a valid PNG, JPG or WebP screenshot.');
}
function animated(): never { throw new Error('Choose a still screenshot, not an animation.'); }
export function assertRawImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width > MAX_RAW_EDGE || height > MAX_RAW_EDGE || width * height > MAX_RAW_PIXELS) {
    throw new Error('This image is too large to open safely. Crop it to the relevant message first.');
  }
}
const ascii = (data: Uint8Array, at: number, length: number) => String.fromCharCode(...data.subarray(at, at + length));
function dimensions(width: number, height: number): ImageDimensions {
  assertRawImageDimensions(width, height);
  return { width, height };
}

function png(data: Uint8Array, view: DataView): ImageDimensions {
  if (data.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => data[i] === byte)) invalid();
  let size: ImageDimensions | undefined;
  let imageBytes = 0;
  for (let at = 8; at < data.length;) {
    if (data.length - at < 12) invalid();
    const length = view.getUint32(at);
    if (length > data.length - at - 12) invalid();
    const kind = ascii(data, at + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(kind)) invalid();
    if (!size && kind !== 'IHDR') invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(kind)) animated();
    if (kind === 'IHDR') {
      if (size || at !== 8 || length !== 13) invalid();
      size = dimensions(view.getUint32(at + 8), view.getUint32(at + 12));
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[data[at + 17]]?.includes(data[at + 16]) || data[at + 18] !== 0 || data[at + 19] !== 0 || data[at + 20] > 1) invalid();
    }
    if (kind === 'IDAT') imageBytes += length;
    at += length + 12;
    if (kind === 'IEND') {
      if (length !== 0 || !size || imageBytes === 0 || at !== data.length) invalid();
      return size;
    }
  }
  return invalid();
}

function jpeg(data: Uint8Array, view: DataView): ImageDimensions {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) invalid();
  let size: ImageDimensions | undefined;
  let at = 2, inScan = false, seenScan = false;
  while (at < data.length) {
    if (inScan) {
      // Skip entropy bytes, stuffed FF bytes and restart markers without reading
      // their contents as segment lengths. Progressive images can have many scans.
      while (at < data.length) {
        if (data[at] !== 0xff) { at++; continue; }
        const markerStart = at;
        while (at < data.length && data[at] === 0xff) at++;
        if (at >= data.length) invalid();
        const next = data[at];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { at++; continue; }
        at = markerStart;
        break;
      }
      inScan = false;
    }
    if (at >= data.length || data[at] !== 0xff) invalid();
    while (at < data.length && data[at] === 0xff) at++;
    if (at >= data.length) invalid();
    const marker = data[at++];
    if (marker === 0xd9) {
      if (!size || !seenScan || at !== data.length) invalid();
      return size;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xdc || marker === 0xde) invalid();
    if (marker === 0x01) continue;
    if (data.length - at < 2) invalid();
    const length = view.getUint16(at);
    if (length < 2 || length > data.length - at) invalid();
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || size || length < 8 || data[at + 2] !== 8) invalid();
      const components = data[at + 7];
      if (components < 1 || components > 4 || length !== 8 + 3 * components) invalid();
      size = dimensions(view.getUint16(at + 5), view.getUint16(at + 3));
    }
    if (marker === 0xda) {
      if (!size || length < 6 || data[at + 2] < 1 || data[at + 2] > 4 || length !== 6 + 2 * data[at + 2]) invalid();
      seenScan = true;
      inScan = true;
    }
    at += length;
  }
  return invalid();
}

function webp(data: Uint8Array, view: DataView): ImageDimensions {
  if (data.length < 20 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== data.length) invalid();
  let canvas: ImageDimensions | undefined, frame: ImageDimensions | undefined;
  for (let at = 12; at < data.length;) {
    if (data.length - at < 8) invalid();
    const kind = ascii(data, at, 4), length = view.getUint32(at + 4, true);
    if (length > data.length - at - 8) invalid();
    const start = at + 8, end = start + length + (length & 1);
    if (end > data.length || (length & 1 && data[end - 1] !== 0)) invalid();
    if (at === 12 && !['VP8X', 'VP8 ', 'VP8L'].includes(kind)) invalid();
    if (kind === 'ANIM' || kind === 'ANMF') animated();
    if (kind === 'VP8X') {
      if (at !== 12 || canvas || length !== 10) invalid();
      if (data[start] & 2) animated();
      if ((data[start] & 0xc1) || data[start + 1] || data[start + 2] || data[start + 3]) invalid();
      const u24 = (p: number) => data[p] + data[p + 1] * 256 + data[p + 2] * 65536;
      canvas = dimensions(u24(start + 4) + 1, u24(start + 7) + 1);
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (frame) invalid();
      if (kind === 'VP8 ') {
        if (length < 10 || (data[start] & 1) || ascii(data, start + 3, 3) !== '\x9d\x01\x2a') invalid();
        frame = dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
      } else {
        if (length < 5 || data[start] !== 0x2f) invalid();
        const bits = view.getUint32(start + 1, true);
        if (bits >>> 29) invalid();
        frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
    }
    at = end;
  }
  if (!frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))) invalid();
  return frame;
}

/** Bounded structural/dimension screening, not proof that compressed pixels decode.
 * No permissive fallback: unknown layouts never reach the browser decoder.
 */
export function preflightImage(data: Uint8Array, mimeType: string): ImageDimensions {
  if (!data.length || data.length > MAX_UPLOAD_BYTES) invalid();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mimeType === 'image/png') return png(data, view);
  if (mimeType === 'image/jpeg') return jpeg(data, view);
  if (mimeType === 'image/webp') return webp(data, view);
  return invalid();
}
