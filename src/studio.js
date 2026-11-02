import sharp from 'sharp';
import { editImage, metaEnabled } from './meta.js';

const SIZE = 1200;
const COLOUR_TOLERANCE = 60;
const PLAIN_BORDER_SHARE = 0.9;
const STUDIO_PROMPT = 'Place the product from this photo on a seamless pure white (#FFFFFF) studio background with a soft, natural shadow beneath it. Keep the product exactly as it is: same colours, shape, texture, printed text and details. Remove the table, floor and any other objects. Add no text, logos or props.';

const NOTE_SUFFIX = 'Keep the product exactly as it is: same colours, shape, fabric, printed text and details. Add no text, logos or watermark.';

// Makes a new photo of the product from the seller's note, such as "put on a mannequin".
// Needs the Meta key, so the caller can show the reason when it is missing.
export async function makeNotePhoto(image, note) {
  if (!metaEnabled()) throw new Error('Making a new photo needs the Meta key on the server.');
  const made = await editImage(image, `${note.trim()}. ${NOTE_SUFFIX}`);
  return sharp(made.buffer).rotate().jpeg({ quality: 92 }).toBuffer();
}

// Returns a marketplace-style main image: square, white background, product centred.
// `method` says how it was made, so the seller knows whether the background was
// fully replaced ('muse-image') or only cleaned locally ('mask' or 'canvas').
export async function makeStudioImage(image) {
  if (metaEnabled() && process.env.META_IMAGE_EDIT !== 'off') {
    try {
      const edited = await editImage(image, STUDIO_PROMPT);
      return { buffer: await toCanvas(edited.buffer), mime: 'image/jpeg', method: 'muse-image' };
    } catch (err) {
      console.warn(`[studio] Muse Image failed, using local cleanup: ${err.message}`);
    }
  }
  return cleanLocally(image.buffer);
}

// If the border is one flat colour, that colour is the background and gets
// cut out. Busy backgrounds are not cut out, because that would damage the product.
async function cleanLocally(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const at = (x, y) => (y * width + x) * 4;

  const border = [];
  for (let x = 0; x < width; x++) border.push(at(x, 0), at(x, height - 1));
  for (let y = 0; y < height; y++) border.push(at(0, y), at(width - 1, y));
  const median = [0, 1, 2].map((c) => {
    const values = border.map((o) => data[o + c]).sort((a, b) => a - b);
    return values[values.length >> 1];
  });
  const near = (o) =>
    Math.abs(data[o] - median[0]) + Math.abs(data[o + 1] - median[1]) + Math.abs(data[o + 2] - median[2]) <= COLOUR_TOLERANCE;

  const plainShare = border.filter(near).length / border.length;
  if (plainShare < PLAIN_BORDER_SHARE) {
    return { buffer: await toCanvas(buffer), mime: 'image/jpeg', method: 'canvas' };
  }

  for (let o = 0; o < data.length; o += 4) data[o + 3] = near(o) ? 0 : 255;
  const cutout = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { buffer: await toCanvas(cutout), mime: 'image/jpeg', method: 'mask' };
}

async function toCanvas(buffer) {
  return sharp(buffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(SIZE, SIZE, { fit: 'contain', background: '#ffffff' })
    .jpeg({ quality: 92 })
    .toBuffer();
}
