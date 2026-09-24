import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIClient } from '../src/engine/aiClient.js';

function clientWithResponses(responses, options = {}) {
  const calls = [];
  const http = { post: async (url, body) => {
    calls.push({ url, body });
    const data = responses.shift();
    if (data instanceof Error) throw data;
    assert.ok(data, 'Unexpected extra AI request');
    return { data };
  } };
  return { client: new AIClient({ baseUrl: 'http://localhost:11434', apiKey: 'test-key', model: 'gpt-oss:120b', analysisOutputTokens: 4096, http, ...options }), calls };
}

test('truncation retries with a larger budget, including an empty answer after thinking', async () => {
  const { client, calls } = clientWithResponses([
    { done: true, done_reason: 'length', message: { content: '', thinking: 'internal trace' } },
    { done: true, done_reason: 'stop', message: { content: 'Complete source findings' } }
  ]);
  const retries = [];
  assert.equal(await client.analyzeSource('Read source', 'file.js:1 code', { onRetry: event => retries.push(event) }), 'Complete source findings');
  assert.deepEqual(calls.map(call => call.body.options.num_predict), [4096, 8192]);
  assert.equal(calls[0].body.think, 'low');
  assert.equal(retries.length, 1);
  assert.ok(!JSON.stringify(calls).includes('internal trace'));
});

test('a long completed answer is not treated as truncated by character count', async () => {
  const text = 'Finished findings. '.repeat(1000);
  const { client, calls } = clientWithResponses([{ done: true, done_reason: 'stop', message: { content: text } }]);
  assert.equal(await client.analyzeSource('Read source', 'code'), text.trim());
  assert.equal(calls.length, 1);
});

test('repeated truncation is bounded and preserves only incomplete answer text', async () => {
  const { client, calls } = clientWithResponses([
    { done_reason: 'length', message: { content: 'first partial' } },
    { done_reason: 'length', message: { content: 'retained partial', thinking: 'private reasoning' } }
  ]);
  await assert.rejects(client.analyzeSource('Read source', 'code'), error => {
    assert.equal(error.code, 'AI_OUTPUT_LIMIT');
    assert.equal(error.partialText, 'retained partial');
    assert.ok(!JSON.stringify(error).includes('private reasoning'));
    return true;
  });
  assert.equal(calls.length, 2);
});

test('other model families are not assigned GPT-OSS reasoning controls', async () => {
  const { client, calls } = clientWithResponses([{ done: true, message: { content: 'result' } }], { model: 'another-model' });
  await client.analyzeSource('Read source', 'code');
  assert.equal(Object.hasOwn(calls[0].body, 'think'), false);
});

test('provider errors are not retried as truncation and do not expose response bodies', async () => {
  const error = Object.assign(new Error('sensitive transport details'), { response: { status: 401, data: 'secret' } });
  const { client, calls } = clientWithResponses([error]);
  await assert.rejects(client.analyzeSource('Read source', 'code'), failure => /HTTP 401/.test(failure.message) && !failure.message.includes('secret'));
  assert.equal(calls.length, 1);
});
