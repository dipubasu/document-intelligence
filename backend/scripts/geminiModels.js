// Lists the Gemini models that can create embeddings.
// It reads GEMINI_API_KEY from backend/.env and never prints the key.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const key = process.env.GEMINI_API_KEY;

// Remove the key from any text before it is printed.
function hide(text) {
  return key ? String(text).split(key).join('[hidden]') : String(text);
}

async function main() {
  if (!key) {
    console.log('GEMINI_API_KEY is missing or empty in backend/.env');
    process.exit(1);
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
  const res = await fetch(url, { headers: { 'x-goog-api-key': key } });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // the answer was not JSON
  }

  if (!res.ok) {
    const msg = body && body.error && body.error.message ? body.error.message : 'no message';
    console.log(`HTTP ${res.status}: ${hide(msg).slice(0, 300)}`);
    process.exit(1);
  }

  const all = body.models || [];
  const embedding = all.filter((m) =>
    (m.supportedGenerationMethods || []).includes('embedContent')
  );
  console.log(`Models returned: ${all.length}; with embedContent: ${embedding.length}`);
  console.log(`More pages available: ${Boolean(body.nextPageToken)}`);
  for (const m of embedding) {
    console.log(
      `${m.name} | input tokens: ${m.inputTokenLimit} | methods: ${(m.supportedGenerationMethods || []).join(',')}`
    );
  }
}

main().catch((err) => {
  console.log(`Request failed: ${hide(err.message)}`);
  process.exit(1);
});