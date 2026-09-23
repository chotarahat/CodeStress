import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Stage0Confirm } from '../src/pipeline/stage0Confirm.js';

async function withLogin(handler, check) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('PIN login sends only the PIN string and retains the returned session', async () => {
  await withLogin(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.url, '/unlock');
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(body), { pin: '00123456' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['session=test; HttpOnly; Path=/'] });
    res.end(JSON.stringify({ success: true, token: 'test-token' }));
  }, async target => {
    const stage = new Stage0Confirm({ target, pin: '00123456', pinLoginPath: '/unlock' });
    const result = await stage.testAuth();
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.type, 'PIN');
    assert.equal(stage.cookie, 'session=test');
    assert.equal(stage.bearer, 'test-token');
    assert.ok(!JSON.stringify(result).includes('00123456'));
  });
});

for (const [name, status, body] of [
  ['rejected PIN', 401, '{"error":"Invalid PIN"}'],
  ['explicit rejection on HTTP 200', 200, '{"success":false}'],
  ['HTML fallback page', 200, '<html>Login page</html>'],
  ['redirect', 302, '']
]) {
  test(`PIN login does not grant access for ${name}`, async () => {
    await withLogin((req, res) => { res.writeHead(status); res.end(body); }, async target => {
      const result = await new Stage0Confirm({ target, pin: '123456' }).testAuth();
      assert.equal(result.authenticated, false);
      assert.equal(result.status, 'FAILED');
    });
  });
}

test('PIN login rejects invalid input and endpoints outside the target', async () => {
  for (const options of [{ pin: '' }, { pin: 1234 }, { pin: '12ab' }, { pin: '1234', pinLoginPath: '//example.com/login' }]) {
    const result = await new Stage0Confirm({ target: 'http://127.0.0.1:1', ...options }).testAuth();
    assert.equal(result.status, 'FAILED');
  }
});
