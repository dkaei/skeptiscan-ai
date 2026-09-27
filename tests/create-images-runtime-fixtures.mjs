// Synthetic local fixtures only. No accounts, network, real messages or image generation.
import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('./fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
const original = await readFile(new URL('screenshot.png', directory));
await sharp(original).jpeg({ quality: 88 }).toFile(fileURLToPath(new URL('screenshot.jpg', directory)));
await sharp(original).webp({ quality: 88 }).toFile(fileURLToPath(new URL('screenshot.webp', directory)));

// Consequential characters never exist in this image: do not infer an amount or URL.
const obscured = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="650">
<rect width="600" height="650" fill="#f5f6fa"/><rect width="600" height="105" fill="white"/>
<g font-family="Arial" fill="#262638"><text x="38" y="62" font-size="26">Messages</text><text x="38" y="149" font-size="22">Unknown sender</text></g>
<rect x="30" y="190" width="535" height="245" rx="22" fill="#e8e9f0"/>
<g font-family="Arial" fill="#262638" font-size="24"><text x="54" y="242">Your parcel could not be delivered.</text><text x="54" y="284">Pay S$</text><text x="190" y="284">to book redelivery.</text><text x="54" y="336" fill="#5553a1">https://</text></g>
<rect x="135" y="260" width="45" height="30" rx="3" fill="#292b34"/><rect x="131" y="309" width="375" height="34" rx="3" fill="#292b34"/>
<g font-family="Arial" font-size="18" fill="#646479"><text x="38" y="564">Amount and destination are deliberately concealed.</text><text x="38" y="594">Synthetic screenshot. No real personal data.</text></g></svg>`;
await sharp(Buffer.from(obscured)).png().toFile(fileURLToPath(new URL('screenshot-obscured.png', directory)));

// Raw pixels are landscape; EXIF orientation 6 asks a viewer to rotate them clockwise.
const orientation = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f5f6fa"/><rect width="80" height="180" fill="#e35050"/><rect x="240" width="80" height="180" fill="#4d79b6"/><text x="95" y="98" font-family="Arial" font-size="18">Synthetic</text></svg>`;
await sharp(Buffer.from(orientation)).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toFile(fileURLToPath(new URL('screenshot-exif-rotated.jpg', directory)));
