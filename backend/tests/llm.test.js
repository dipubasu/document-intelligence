// Tests for the LLM client. The real network is never used: fetch is replaced by a mock.
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_MODEL = 'test-model';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { chatJson, LlmError } = require('../src/services/llm');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MESSAGES = [{ role: 'user', content: 'hi' }];

function okResponse(content, finishReason = 'stop') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: { total_tokens: 1 },
      }),
  };
}

function errorResponse(status, body = '{"error":"x"}') {
  return { ok: false, status, headers: { get: () => null }, text: async () => body };
}

test('llm: sends JSON mode, temperature 0, model and auth header', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return okResponse('{"a":1}');
  };
  const out = await chatJson(MESSAGES, { baseDelayMs: 1 });
  const body = JSON.parse(seen.init.body);
  assert.strictEqual(out.content, '{"a":1}');
  assert.strictEqual(body.model, 'test-model');
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.response_format.type, 'json_object');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer test-key');
});

test('llm: a 429 is retried and then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls < 3 ? errorResponse(429) : okResponse('{"ok":true}');
  };
  const out = await chatJson(MESSAGES, { baseDelayMs: 1 });
  assert.strictEqual(calls, 3);
  assert.strictEqual(out.attempts, 3);
});

test('llm: a 400 is not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return errorResponse(400);
  };
  await assert.rejects(
    chatJson(MESSAGES, { baseDelayMs: 1 }),
    (err) => err instanceof LlmError && err.status === 400 && err.retryable === false
  );
  assert.strictEqual(calls, 1);
});

test('llm: gives up after the maximum number of retries', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return errorResponse(500);
  };
  await assert.rejects(chatJson(MESSAGES, { maxRetries: 2, baseDelayMs: 1 }), LlmError);
  assert.strictEqual(calls, 3);
});

test('llm: a cut-off answer is an error and is not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse('{"a":', 'length');
  };
  await assert.rejects(chatJson(MESSAGES, { baseDelayMs: 1 }), /cut off/);
  assert.strictEqual(calls, 1);
});

test('llm: never more than 2 requests run at the same time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return okResponse('{"ok":true}');
  };
  await Promise.all(Array.from({ length: 6 }, () => chatJson(MESSAGES, { baseDelayMs: 1 })));
  assert.ok(maxInFlight <= 2, `max in flight was ${maxInFlight}`);
});

test('llm: a 413 gives a short message and never shows the raw provider text', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return errorResponse(
      413,
      '{"error":{"message":"Request too large in organization `org_secret123` on tokens per minute"}}'
    );
  };
  await assert.rejects(
    chatJson(MESSAGES, { baseDelayMs: 1 }),
    (err) =>
      err instanceof LlmError &&
      err.status === 413 &&
      err.retryable === false &&
      err.message.includes('too large') &&
      !err.message.includes('org_secret123') &&
      !err.message.includes('tokens per minute')
  );
  assert.strictEqual(calls, 1);
});

test('llm: a 401 gives a short message about the key and is not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return errorResponse(401, '{"error":{"message":"Invalid API Key sk-secret-value"}}');
  };
  await assert.rejects(
    chatJson(MESSAGES, { baseDelayMs: 1 }),
    (err) =>
      err instanceof LlmError &&
      err.retryable === false &&
      err.message.includes('API key') &&
      !err.message.includes('sk-secret-value')
  );
  assert.strictEqual(calls, 1);
});