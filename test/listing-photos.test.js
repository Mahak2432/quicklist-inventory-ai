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
const { addPhoto, aiEditPhoto, createDraft, getDraft, publicMedia, publishDraft, removePhoto, replacePhoto, updateDraft, wantsNotePhoto } = await import('../src/listing.js');
const { readImage, storeImage, verifyMedia } = await import('../src/uploads.js');

const blankPng = () => sharp({ create: { width: 200, height: 200, channels: 3, background: '#f2f2f2' } }).png().toBuffer();

// One in-memory database per test file. Each shop has its own tenant_id, so tests stay separate.
const sharedDb = openDb('pglite:memory');
const freshShop = async () => {
  const db = await sharedDb;
  const { tenantId } = await createTenant(db, 'Photo shop');
  return { db, tenantId };
};

test('a stored photo is read back from the database, and an unknown name finds nothing', async () => {
  const { db } = await freshShop();
  const png = await blankPng();
  const name = await storeImage(db, png, 'image/png');
  const back = await readImage(db, name);
  assert.equal(back.mime, 'image/png');
  assert.deepEqual(Buffer.from(back.buffer), png);
  assert.equal(await readImage(db, 'missing-photo.png'), null);
  assert.equal(await readImage(db, '../secret.png'), null);
});

test('AI photo editing says why it cannot run without the Meta key, and refuses an empty instruction', async () => {
  const { db, tenantId } = await freshShop();
  const png = await blankPng();
  const draft = await createDraft(db, tenantId, { title: 'Plain tee', category: 'GENERIC' }, await storeImage(db, png, 'image/png'));
  await assert.rejects(aiEditPhoto(db, tenantId, draft.id, 0, 'plain light grey backdrop'), (err) => err.code === 'AI_OFF');
  await assert.rejects(aiEditPhoto(db, tenantId, draft.id, 0, '   '), (err) => err.code === 'BAD_INPUT');
});

test('a note asking for a mannequin or model shot is recognised, and a plain description is not', () => {
  assert.equal(wantsNotePhoto('put on manequene'), true);
  assert.equal(wantsNotePhoto('Put it on a mannequin'), true);
  assert.equal(wantsNotePhoto('navy running shoes, size 7'), false);
  assert.equal(wantsNotePhoto(undefined), false);
});

test('a listing takes several photos, each with its own white-background choice, and publishes one signed link per photo', async () => {
  const { db, tenantId } = await freshShop();
  const png = await blankPng();
  const first = await createDraft(db, tenantId, { title: 'Blue kurta', category: 'GENERIC', color: 'Blue' }, await storeImage(db, png, 'image/png'));
  await addPhoto(db, tenantId, first.id, { buffer: png, mime: 'image/png' });
  const withNote = await addPhoto(db, tenantId, first.id, { buffer: png, mime: 'image/png', source: 'generated', front: true });
  assert.deepEqual(withNote.draft.photos.map((p) => p.source), ['generated', 'upload', 'upload']);

  // The generated photo goes on the listing with a white background. The others stay as they are.
  await updateDraft(db, tenantId, first.id, { photo_mode: { index: 0, mode: 'STUDIO' } });
  const draft = (await getDraft(db, tenantId, first.id)).draft;
  assert.equal(draft.photos[0].mode, 'STUDIO');
  assert.ok(draft.photos[0].enhanced, 'the white-background version is stored');
  assert.equal(draft.photos[1].mode, 'ORIGINAL');

  await updateDraft(db, tenantId, first.id, { answers: { stock_total: 4, mrp: 500, selling_price: 300 } });
  const product = await publishDraft(db, tenantId, first.id);
  assert.equal(product.media_urls.length, 3);
  assert.match(product.media_urls[0], /\/0-enhanced\?sig=/);
  assert.match(product.media_urls[1], /\/1-original\?sig=/);

  const url = new URL(product.media_urls[1], 'http://localhost');
  assert.equal(verifyMedia(first.id, '1-original', url.searchParams.get('sig')), true);
  assert.ok(await publicMedia(db, first.id, '1-original'), 'the second photo can be served');
  assert.equal(await publicMedia(db, first.id, '9-original'), null, 'a photo that does not exist is not served');
});

test('an edited photo replaces its original, and a removed photo leaves the listing', async () => {
  const { db, tenantId } = await freshShop();
  const png = await blankPng();
  const draft = await createDraft(db, tenantId, { title: 'Grey hoodie', category: 'GENERIC' }, await storeImage(db, png, 'image/png'));
  await addPhoto(db, tenantId, draft.id, { buffer: png, mime: 'image/png' });

  const before = (await getDraft(db, tenantId, draft.id)).draft.photos[1].original;
  const edited = await replacePhoto(db, tenantId, draft.id, 1, { buffer: png, mime: 'image/png' });
  assert.equal(edited.draft.photos[1].source, 'edited');
  assert.notEqual(edited.draft.photos[1].original, before);

  const removed = await removePhoto(db, tenantId, draft.id, 0);
  assert.equal(removed.draft.photos.length, 1);
  assert.equal(removed.draft.photos[0].source, 'edited');
});

test('drafts saved with one photo before multi-photo listings still open and publish', async () => {
  const { db, tenantId } = await freshShop();
  const png = await blankPng();
  const legacy = await createDraft(db, tenantId, { title: 'Old listing', category: 'GENERIC' }, await storeImage(db, png, 'image/png'));
  const row = await db.prepare('SELECT draft_json FROM listing_drafts WHERE id = ?').get(legacy.id);
  const saved = JSON.parse(row.draft_json);
  delete saved.photos;
  saved.images = { mode: 'ORIGINAL', studio: null, studio_method: null };
  await db.prepare('UPDATE listing_drafts SET draft_json = ? WHERE id = ?').run(JSON.stringify(saved), legacy.id);

  const view = await getDraft(db, tenantId, legacy.id);
  assert.equal(view.draft.photos.length, 1);
  assert.equal(view.draft.photos[0].mode, 'ORIGINAL');
  assert.ok(await publicMedia(db, legacy.id, 'original'), 'the old link name still serves the photo');
});
