// One-off check of the Groq API. This is not part of the application.
// It sends a tiny invoice text and prints what the model returns.
const config = require('../src/config');

async function main() {
  const { apiKey, model } = config.groq;
  if (!apiKey) {
    console.log('GROQ_API_KEY is missing in backend/.env');
    process.exit(1);
  }

  const body = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Extract invoice data from the text. Reply with JSON only, using exactly these keys: ' +
          'invoice_number, total, currency, customer_name. ' +
          'Use null for any value that is not written in the text. Never guess.',
      },
      { role: 'user', content: 'Invoice INV-77\nTotal: 110.50 USD' },
    ],
  };

  const started = Date.now();
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const elapsed = Date.now() - started;
  const raw = await res.text();

  console.log('model:', model);
  console.log('status:', res.status);
  console.log('time ms:', elapsed);

  if (!res.ok) {
    console.log('error body:', raw.slice(0, 600));
    return;
  }

  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content;
  console.log('content:', content);
  console.log('usage:', JSON.stringify(data.usage));

  try {
    JSON.parse(content);
    console.log('valid JSON: yes');
  } catch {
    console.log('valid JSON: no');
  }
}

main().catch((err) => {
  console.log('request failed:', err.message);
  process.exit(1);
});