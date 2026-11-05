const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const {
  EmbeddingError,
  NOT_CONFIGURED_MESSAGE,
  MAX_EMBEDDING_CHARS,
  embed,
  toBlob,
  fromBlob,
  cosine,
  hashText,
  buildEmbeddingText,
} = require('../src/services/embeddings');

const savedFetch = global.fetch;
const savedKey = config.gemini.apiKey;
const savedModel = config.gemini.embeddingModel;

function configure() {
  config.gemini.apiKey = 'test-key';
  config.gemini.embeddingModel = 'test-model';
}

afterEach(() => {
  global.fetch = savedFetch;
  config.gemini.apiKey = savedKey;
  config.gemini.embeddingModel = savedModel;
});

test('a vector survives the round trip to a BLOB and back', () => {
  const back = fromBlob(toBlob([0.5, -1.25, 3]));
  assert.deepEqual(Array.from(back), [0.5, -1.25, 3]);
});

test('fromBlob works when the buffer does not start on a 4-byte boundary', () => {
  const padded = Buffer.concat([Buffer.from([0]), toBlob([1, 2])]);
  const back = fromBlob(padded.subarray(1));
  assert.deepEqual(Array.from(back), [1, 2]);
});

test('cosine gives 1 for the same direction, 0 for unrelated and -1 for opposite', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9);
});

test('cosine returns 0 for a zero vector or vectors of different length', () => {
  assert.equal(cosine([0, 0], [1, 2]), 0);
  assert.equal(cosine([1, 2, 3], [1, 2]), 0);
  assert.equal(cosine([], []), 0);
});

test('hashText is stable and changes with the text', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
});

test('buildEmbeddingText keeps the filled fields and skips the empty ones', () => {
  const text = buildEmbeddingText(
    {
      original_name: 'a.csv',
      invoice_number: 'N-1',
      invoice_date: null,
      supplier_name: 'Northwind',
      customer_name: '',
      total: 99,
      currency: 'USD',
    },
    [{ description: 'Notebook' }, { description: null }, { description: 'Marker' }],
    [{ text: 'Hello   world\n page' }]
  );
  assert.ok(text.includes('Invoice number: N-1'));
  assert.ok(text.includes('Supplier: Northwind'));
  assert.ok(text.includes('Total: 99 USD'));
  assert.ok(text.includes('Items: Notebook; Marker'));
  assert.ok(text.includes('Text: Hello world page'));
  assert.ok(!text.includes('Date'));
  assert.ok(!text.includes('Customer'));
});

test('buildEmbeddingText cuts very long text', () => {
  const text = buildEmbeddingText({ original_name: 'big.pdf' }, [], [{ text: 'x'.repeat(20000) }]);
  assert.equal(text.length, MAX_EMBEDDING_CHARS);
});

test('embed refuses to run without a key and does not call the network', async () => {
  config.gemini.apiKey = '';
  config.gemini.embeddingModel = 'test-model';
  global.fetch = async () => {
    throw new Error('fetch must not be called');
  };
  await assert.rejects(embed('hello', 'RETRIEVAL_QUERY'), (err) => {
    assert.equal(err.code, 'NOT_CONFIGURED');
    assert.equal(err.message, NOT_CONFIGURED_MESSAGE);
    return true;
  });
});

test('embed sends the key in a header and the task type in the body, and returns the vector', async () => {
  configure();
  let seen = null;
  global.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, json: async () => ({ embedding: { values: [0.1, 0.2] } }) };
  };
  const values = await embed('hello', 'RETRIEVAL_DOCUMENT');
  assert.deepEqual(values, [0.1, 0.2]);
  assert.ok(seen.url.includes('test-model:embedContent'));
  assert.ok(!seen.url.includes('test-key'));
  assert.equal(seen.options.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(seen.options.body);
  assert.equal(body.taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(body.content.parts[0].text, 'hello');
});

test('embed hides the provider message when the API returns an error', async () => {
  configure();
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'secret org_abc123 details' } }),
  });
  await assert.rejects(embed('hello', 'RETRIEVAL_QUERY'), (err) => {
    assert.ok(err instanceof EmbeddingError);
    assert.equal(err.status, 429);
    assert.ok(err.message.includes('429'));
    assert.ok(!err.message.includes('org_abc123'));
    return true;
  });
});

test('embed reports an answer without a vector as a bad response', async () => {
  configure();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(embed('hello', 'RETRIEVAL_QUERY'), (err) => {
    assert.equal(err.code, 'BAD_RESPONSE');
    return true;
  });
});

test('embed reports a network failure without leaking the original error', async () => {
  configure();
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED with test-key inside');
  };
  await assert.rejects(embed('hello', 'RETRIEVAL_QUERY'), (err) => {
    assert.equal(err.code, 'NETWORK');
    assert.ok(!err.message.includes('test-key'));
    return true;
  });
});