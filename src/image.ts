import { assertRawImageDimensions, MAX_UPLOAD_BYTES, preflightImage } from './imagePreflight';

export interface PreparedImage { base64: string; mimeType: 'image/jpeg'; preview: string; name: string; width: number; height: number }
const LIMIT = 2 * 1024 * 1024;
/** Client preparation improves upload size and usability; the server must validate again. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Choose an image smaller than 10 MB.');
  if (!file.size) throw new Error('This image is empty. Choose another screenshot.');
  const expected = preflightImage(new Uint8Array(await file.arrayBuffer()), file.type);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('This image could not be opened. Choose another screenshot.'); }
  try {
    assertRawImageDimensions(bitmap.width, bitmap.height);
    // EXIF orientation may rotate the decoded image by 90 degrees. Other changes
    // mean the screened dimensions did not describe what the decoder produced.
    const matches = bitmap.width === expected.width && bitmap.height === expected.height;
    const rotated = bitmap.width === expected.height && bitmap.height === expected.width;
    if (!matches && !rotated) throw new Error('This image has inconsistent dimensions. Choose another screenshot.');
    let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height), Math.sqrt(6_000_000 / (bitmap.width * bitmap.height)));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image preparation is unavailable in this browser. Paste the message instead.');
    let blob: Blob | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', attempt < 2 ? .92 : .82));
      if (blob && blob.size <= LIMIT) break;
      scale *= .8;
    }
    if (!blob || blob.size > LIMIT) throw new Error('This screenshot is too large to prepare. Choose a shorter screenshot.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { base64: btoa(binary), mimeType: 'image/jpeg', preview: URL.createObjectURL(blob), name: file.name, width: canvas.width, height: canvas.height };
  } finally { bitmap.close(); }
}
