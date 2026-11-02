import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'quicklist-inventory-ai-test-'));
delete process.env.META_API_KEY;

const { openDb } = await import('../src/db.js');
const { createTenant } = await import('../src/auth.js');
const { addPhoto, createDraft, getDraft, publicMedia, publishDraft, removePhoto, replacePhoto, updateDraft, wantsNotePhoto } = await import('../src/listing.js');
const { storeImage, verifyMedia } = await import('../src/uploads.js');

const blankPng = () => sharp({ create: { width: 200, height: 200, channels: 3, background: '#f2f2f2' } }).png().toBuffer();

const freshShop = () => {
  const db = openDb(':memory:');
  const { tenantId } = createTenant(db, 'Photo shop');
  return { db, tenantId };
};

test('a note asking for a mannequin or model shot is recognised, and a plain description is not', () => {
  assert.equal(wantsNotePhoto('put on manequene'), true);
  assert.equal(wantsNotePhoto('Put it on a mannequin'), true);
  assert.equal(wantsNotePhoto('navy running shoes, size 7'), false);
  assert.equal(wantsNotePhoto(undefined), false);
});

test('a listing takes several photos, each with its own white-background choice, and publishes one signed link per photo', async () => {
  const { db, tenantId } = freshShop();
  const png = await blankPng();
  const first = createDraft(db, tenantId, { title: 'Blue kurta', category: 'GENERIC', color: 'Blue' }, storeImage(png, 'image/png'));
  addPhoto(db, tenantId, first.id, { buffer: png, mime: 'image/png' });
  const withNote = addPhoto(db, tenantId, first.id, { buffer: png, mime: 'image/png', source: 'generated', front: true });
  assert.deepEqual(withNote.draft.photos.map((p) => p.source), ['generated', 'upload', 'upload']);

  // The generated photo goes on the listing with a white background. The others stay as they are.
  await updateDraft(db, tenantId, first.id, { photo_mode: { index: 0, mode: 'STUDIO' } });
  const draft = getDraft(db, tenantId, first.id).draft;
  assert.equal(draft.photos[0].mode, 'STUDIO');
  assert.ok(draft.photos[0].enhanced, 'the white-background version is stored');
  assert.equal(draft.photos[1].mode, 'ORIGINAL');

  await updateDraft(db, tenantId, first.id, { answers: { stock_total: 4, mrp: 500, selling_price: 300 } });
  const product = publishDraft(db, tenantId, first.id);
  assert.equal(product.media_urls.length, 3);
  assert.match(product.media_urls[0], /\/0-enhanced\?sig=/);
  assert.match(product.media_urls[1], /\/1-original\?sig=/);

  const url = new URL(product.media_urls[1], 'http://localhost');
  assert.equal(verifyMedia(first.id, '1-original', url.searchParams.get('sig')), true);
  assert.ok(publicMedia(db, first.id, '1-original'), 'the second photo can be served');
  assert.equal(publicMedia(db, first.id, '9-original'), null, 'a photo that does not exist is not served');
});

test('an edited photo replaces its original, and a removed photo leaves the listing', async () => {
  const { db, tenantId } = freshShop();
  const png = await blankPng();
  const draft = createDraft(db, tenantId, { title: 'Grey hoodie', category: 'GENERIC' }, storeImage(png, 'image/png'));
  addPhoto(db, tenantId, draft.id, { buffer: png, mime: 'image/png' });

  const before = getDraft(db, tenantId, draft.id).draft.photos[1].original;
  const edited = await replacePhoto(db, tenantId, draft.id, 1, { buffer: png, mime: 'image/png' });
  assert.equal(edited.draft.photos[1].source, 'edited');
  assert.notEqual(edited.draft.photos[1].original, before);

  const removed = removePhoto(db, tenantId, draft.id, 0);
  assert.equal(removed.draft.photos.length, 1);
  assert.equal(removed.draft.photos[0].source, 'edited');
});

test('drafts saved with one photo before multi-photo listings still open and publish', async () => {
  const { db, tenantId } = freshShop();
  const png = await blankPng();
  const legacy = createDraft(db, tenantId, { title: 'Old listing', category: 'GENERIC' }, storeImage(png, 'image/png'));
  const saved = JSON.parse(db.prepare('SELECT draft_json FROM listing_drafts WHERE id = ?').get(legacy.id).draft_json);
  delete saved.photos;
  saved.images = { mode: 'ORIGINAL', studio: null, studio_method: null };
  db.prepare('UPDATE listing_drafts SET draft_json = ? WHERE id = ?').run(JSON.stringify(saved), legacy.id);

  const view = getDraft(db, tenantId, legacy.id);
  assert.equal(view.draft.photos.length, 1);
  assert.equal(view.draft.photos[0].mode, 'ORIGINAL');
  assert.ok(publicMedia(db, legacy.id, 'original'), 'the old link name still serves the photo');
});
