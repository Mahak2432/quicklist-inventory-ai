// Renders the sample product photos used by the demo shop into public/samples.
// Run once with: node scripts/make-samples.js
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';

const outDir = join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'samples');
mkdirSync(outDir, { recursive: true });

const shadow = (y, rx) => `<ellipse cx="400" cy="${y}" rx="${rx}" ry="18" fill="#000" opacity="0.12"/>`;

const SAMPLES = {
  'navy-running-shoe.png': `
    ${shadow(575, 300)}
    <path d="M150 470 C170 360 280 300 360 330 L470 370 C560 390 620 420 640 470 L650 520 L150 520 Z" fill="#2e3f8f"/>
    <path d="M470 370 C560 390 620 420 640 470 L560 470 C540 430 505 405 470 370 Z" fill="#e6e9f6"/>
    <path d="M150 520 L650 520 L650 545 Q650 562 633 562 L167 562 Q150 562 150 545 Z" fill="#171a2b"/>
    <path d="M330 345 L400 395 M362 330 L432 380 M394 316 L464 364" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>`,

  'block-print-kurta.png': `
    <defs>
      <pattern id="print" width="60" height="60" patternUnits="userSpaceOnUse">
        <circle cx="30" cy="30" r="7" fill="#e3a12a"/>
        <circle cx="0" cy="0" r="4" fill="#e3a12a"/>
        <circle cx="60" cy="60" r="4" fill="#e3a12a"/>
      </pattern>
    </defs>
    ${shadow(722, 210)}
    <path d="M330 120 L470 120 L560 200 L650 420 L600 440 L560 300 L560 700 L240 700 L240 300 L200 440 L150 420 L240 200 Z" fill="#2e3f8f"/>
    <path d="M330 120 L470 120 L560 200 L560 700 L240 700 L240 200 Z" fill="url(#print)" opacity="0.9"/>
    <path d="M330 120 L400 200 L470 120" fill="none" stroke="#ffffff" stroke-width="10"/>`,

  'grey-hoodie.png': `
    ${shadow(712, 230)}
    <path d="M300 170 Q400 60 500 170 L500 240 L300 240 Z" fill="#9aa0b4"/>
    <path d="M330 175 Q400 110 470 175 L470 235 L330 235 Z" fill="#c9cdd8"/>
    <path d="M280 230 L520 230 L600 330 L600 700 L200 700 L200 330 Z" fill="#b7bccb"/>
    <path d="M280 230 L200 330 L150 560 L200 575 L240 420 Z" fill="#b7bccb"/>
    <path d="M520 230 L600 330 L650 560 L600 575 L560 420 Z" fill="#b7bccb"/>
    <path d="M300 530 L500 530 L520 630 L280 630 Z" fill="#a3a9ba"/>
    <path d="M370 240 L362 330 M430 240 L438 330" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
    <rect x="200" y="686" width="400" height="14" fill="#9aa0b4"/>`,
};

for (const [name, body] of Object.entries(SAMPLES)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><rect width="800" height="800" fill="#ffffff"/>${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(outDir, name));
  console.log(`wrote public/samples/${name}`);
}
