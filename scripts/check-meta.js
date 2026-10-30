// Checks the Meta Model API key in .env. Prints results only, never the key.
// Run with: npm run check:meta

const BASE_URL = (process.env.META_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, '');
const MODEL = process.env.META_SPARK_MODEL || 'muse-spark-1.1';
const key = process.env.META_API_KEY;

if (!key) {
  console.log('META_API_KEY is empty. Add it to .env (see README, "Set up the Meta key"), then run this again.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const timeout = () => AbortSignal.timeout(30_000);

console.log(`Base URL: ${BASE_URL}`);
console.log(`Model:    ${MODEL}`);

const models = await fetch(`${BASE_URL}/models`, { headers, signal: timeout() }).catch((err) => ({ networkError: err.message }));
if (models.networkError) {
  console.log(`Could not reach ${BASE_URL}: ${models.networkError}`);
  process.exit(1);
}
if (models.ok) {
  const ids = ((await models.json()).data ?? []).map((m) => m.id);
  const muse = ids.filter((id) => /muse|sam/i.test(id));
  console.log(`Models this key can see: ${ids.length}`);
  console.log(`Muse and SAM models: ${muse.join(', ') || 'none listed'}`);
  if (ids.length && !ids.includes(MODEL)) {
    console.log(`${MODEL} is not in that list. Set META_SPARK_MODEL to one of the names above.`);
  }
} else {
  console.log(`The model list returned ${models.status}. This is fine if the address does not offer /models. Trying the reply call.`);
}

const reply = await fetch(`${BASE_URL}/responses`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model: MODEL, input: 'Reply with the single word OK.' }),
  signal: timeout(),
}).catch((err) => ({ networkError: err.message }));

if (reply.networkError) {
  console.log(`The reply call could not connect: ${reply.networkError}`);
  process.exit(1);
}
if (!reply.ok) {
  const detail = (await reply.text()).slice(0, 200);
  console.log(`The reply call failed with ${reply.status}. ${detail}`);
  process.exit(1);
}

console.log('Reply call worked. The key is valid and the model answers.');
