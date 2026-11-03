import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'quicklist-accounts-'));
process.env.SIGNUP_PER_HOUR = '100';
process.env.LOGIN_PER_HOUR = '100';
delete process.env.META_API_KEY;

const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');

let server;
let base;

const post = (path, body, token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body ?? {}),
});

before(async () => {
  server = createApp(await openDb('pglite:memory'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('signing up opens a shop, and its token works', async () => {
  const res = await post('/api/auth/signup', { shop_name: 'Meera Kurtis', email: 'Meera@Example.com', password: 'correct horse' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.email, 'meera@example.com');
  const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).tenant.name, 'Meera Kurtis');
});

test('one email opens one shop, and logging in needs the right password', async () => {
  const duplicate = await post('/api/auth/signup', { shop_name: 'Other', email: 'meera@example.com', password: 'another-pass' });
  assert.equal(duplicate.status, 409);

  const wrong = await post('/api/auth/login', { email: 'meera@example.com', password: 'wrong-password' });
  assert.equal(wrong.status, 401);

  const unknown = await post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever-pass' });
  assert.equal(unknown.status, 401);

  const ok = await post('/api/auth/login', { email: 'MEERA@example.com', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token.startsWith('qli_'));
});

test('short passwords and bad emails are refused before anything is stored', async () => {
  const short = await post('/api/auth/signup', { shop_name: 'X', email: 'x@example.com', password: 'short' });
  assert.equal(short.status, 400);
  const bad = await post('/api/auth/signup', { shop_name: 'X', email: 'not-an-email', password: 'long-enough-pass' });
  assert.equal(bad.status, 400);
});

test('logging out revokes the token', async () => {
  const login = await (await post('/api/auth/login', { email: 'meera@example.com', password: 'correct horse' })).json();
  const out = await post('/api/auth/logout', {}, login.token);
  assert.equal(out.status, 200);
  const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${login.token}` } });
  assert.equal(me.status, 401);
});
