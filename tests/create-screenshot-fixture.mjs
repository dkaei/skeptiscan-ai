// Synthetic UI-only fixture. Never enables or calls a paid service.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="650">
<rect width="600" height="650" fill="#f5f6fa"/>
<rect width="600" height="105" fill="white"/>
<g font-family="Arial" fill="#262638"><text x="38" y="62" font-size="26">Messages</text>
<text x="38" y="149" font-size="22">Unknown sender</text></g>
<rect x="30" y="190" width="535" height="245" rx="22" fill="#e8e9f0"/>
<g font-family="Arial" fill="#262638" font-size="24">
<text x="54" y="242">Your parcel could not be delivered.</text>
<text x="54" y="284">Pay S$1.99 to book redelivery.</text>
<text x="54" y="336" fill="#5553a1">www.parcel.example</text>
<text x="38" y="594" font-size="18" fill="#646479">Synthetic screenshot for local interface tests.</text></g></svg>`;
await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('./fixtures/screenshot.png', import.meta.url)));
