// Thin client for the Groq chat API (OpenAI-compatible endpoint).
// - asks for JSON output at temperature 0
// - retries temporary failures (429, 5xx, network, timeout) with backoff
// - allows at most MAX_CONCURRENT requests at the same time
const config = require('../config');
const logger = require('../utils/logger');

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60000;
const MAX_CONCURRENT = 2;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 30000;

class LlmError extends Error {
  constructor(message, { retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Simple semaphore: a slot is handed directly to the next waiting caller.
let active = 0;
const waiting = [];

async function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(res) {
  const header = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return null;
}

// Short, safe description of an HTTP error. The raw provider text is never
// put into the error message, because it can contain account details.
function describeStatus(status) {
  if (status === 413) return 'the document text is too large for the model request limit';
  if (status === 429) return 'the AI service is busy or a rate limit was reached';
  if (status === 401 || status === 403) return 'the AI service rejected the API key or access';
  if (status >= 500) return 'temporary problem at the AI service';
  return 'the AI service rejected the request';
}

async function callOnce(messages, apiKey, model) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmError(`LLM request failed: ${err.message}`, { retryable: true });
  }

  const raw = await res.text();

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    // Full provider text goes to the log only, never to the user.
    logger.warn('llm api error', { status: res.status, body: raw.slice(0, 500) });
    throw new LlmError(
      `LLM API returned status ${res.status} (${describeStatus(res.status)})`,
      {
        retryable,
        status: res.status,
        retryAfterMs: parseRetryAfter(res),
      },
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError('LLM API returned a body that is not JSON', { retryable: true });
  }

  const choice = data.choices && data.choices[0];
  if (choice && choice.finish_reason === 'length') {
    throw new LlmError('LLM response was cut off (output limit reached)', { retryable: false });
  }
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || content === '') {
    throw new LlmError('LLM API returned an empty answer', { retryable: true });
  }

  return { content, usage: data.usage || null, model };
}

async function chatJson(messages, options = {}) {
  const { apiKey, model } = config.groq;
  if (!apiKey) throw new LlmError('GROQ_API_KEY is not set', { retryable: false });
  if (!model) throw new LlmError('GROQ_MODEL is not set', { retryable: false });

  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt += 1) {
    let delay = 0;
    await acquire();
    const started = Date.now();
    try {
      const result = await callOnce(messages, apiKey, model);
      return { ...result, durationMs: Date.now() - started, attempts: attempt + 1 };
    } catch (err) {
      if (!(err instanceof LlmError) || !err.retryable || attempt >= maxRetries) throw err;
      delay =
        err.retryAfterMs ?? baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs * 0.25;
      logger.warn('llm call failed, will retry', {
        attempt: attempt + 1,
        status: err.status,
        delayMs: Math.round(delay),
      });
    } finally {
      release();
    }
    // Wait outside the slot so other requests can use it.
    await sleep(delay);
  }
}

module.exports = { chatJson, LlmError };