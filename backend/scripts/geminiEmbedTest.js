// Checks that the Gemini embedding models work with the key in backend/.env.
// It never prints the key.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const key = process.env.GEMINI_API_KEY;

function hide(text) {
  return key ? String(text).split(key).join('[hidden]') : String(text);
}

async function embed(model, text, extra = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] }, ...extra }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // the answer was not JSON
  }
  if (!res.ok) {
    const msg = body && body.error && body.error.message ? body.error.message : 'no message';
    return { ok: false, status: res.status, message: hide(msg).slice(0, 200) };
  }
  const values = body && body.embedding && body.embedding.values;
  return { ok: Array.isArray(values), status: res.status, values };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  if (!key) {
    console.log('GEMINI_API_KEY is missing or empty in backend/.env');
    process.exit(1);
  }

  const cases = [
    ['gemini-embedding-001', 'plain', {}],
    ['gemini-embedding-001', 'taskType RETRIEVAL_DOCUMENT', { taskType: 'RETRIEVAL_DOCUMENT' }],
    ['gemini-embedding-2', 'plain', {}],
    ['gemini-embedding-2', 'taskType RETRIEVAL_DOCUMENT', { taskType: 'RETRIEVAL_DOCUMENT' }],
  ];

  for (const [model, label, extra] of cases) {
    const r = await embed(model, 'Invoice from Northwind Traders for school notebooks', extra);
    if (r.ok) {
      console.log(`${model} | ${label} | HTTP ${r.status} | vector length ${r.values.length}`);
    } else {
      console.log(`${model} | ${label} | HTTP ${r.status} | ${r.message}`);
    }
  }

  // Meaning test with the first model: related texts should score higher.
  const model = 'gemini-embedding-001';
  const a = await embed(model, 'Invoice from Northwind Traders for school notebooks and markers');
  const b = await embed(model, 'bill for stationery supplies');
  const c = await embed(model, 'weather forecast for tomorrow in Dhaka');
  if (a.ok && b.ok && c.ok) {
    console.log(`similarity invoice vs stationery bill: ${cosine(a.values, b.values).toFixed(3)}`);
    console.log(`similarity invoice vs weather forecast: ${cosine(a.values, c.values).toFixed(3)}`);
  } else {
    console.log('meaning test skipped because a call failed');
  }
}

main().catch((err) => {
  console.log(`Request failed: ${hide(err.message)}`);
  process.exit(1);
});