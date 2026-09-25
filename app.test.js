const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('./app');

// Each test gets a fresh server (and therefore a fresh in-memory store).
function withServer(fn) {
  return async () => {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  };
}

test('GET /health returns 200 with version and timestamp', withServer(async (base) => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp must be a valid date');
}));

test('GET / serves the HTML dashboard', withServer(async (base) => {
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const html = await res.text();
  assert.match(html, /<title>demo-project<\/title>/);
  // The page must pull its data from the API, not hardcode it.
  assert.match(html, /fetch\('\/api\/info'\)/);
}));

test('GET /api/info reports runtime metadata', withServer(async (base) => {
  const res = await fetch(`${base}/api/info`);
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.version, require('./package.json').version);
  assert.match(body.node, /^v\d+/);
  assert.ok(typeof body.uptimeSeconds === 'number');
}));

test('GET /api/items returns the seeded list', withServer(async (base) => {
  const res = await fetch(`${base}/api/items`);
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.count, body.items.length);
  assert.ok(body.items.length >= 1);
  assert.ok(Object.hasOwn(body.items[0], 'done'));
}));

test('POST /api/items creates an item, GET fetches it back', withServer(async (base) => {
  const created = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ship it' })
  });
  assert.strictEqual(created.status, 201);

  const item = await created.json();
  assert.strictEqual(item.name, 'ship it');
  assert.strictEqual(item.done, false);

  const fetched = await (await fetch(`${base}/api/items/${item.id}`)).json();
  assert.deepStrictEqual(fetched, item);
}));

test('POST /api/items rejects a missing name with 400', withServer(async (base) => {
  const res = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '   ' })
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'name is required');
}));

test('DELETE /api/items/:id removes it, second delete is 404', withServer(async (base) => {
  const del = await fetch(`${base}/api/items/1`, { method: 'DELETE' });
  assert.strictEqual(del.status, 204);

  const again = await fetch(`${base}/api/items/1`, { method: 'DELETE' });
  assert.strictEqual(again.status, 404);

  const gone = await fetch(`${base}/api/items/1`);
  assert.strictEqual(gone.status, 404);
}));

test('GET /api/echo reflects the query string', withServer(async (base) => {
  const res = await fetch(`${base}/api/echo?msg=hi&n=2`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).youSent, { msg: 'hi', n: '2' });
}));

test('GET /api/error always returns 500', withServer(async (base) => {
  const res = await fetch(`${base}/api/error`);
  assert.strictEqual(res.status, 500);
  assert.strictEqual((await res.json()).error, 'deliberate test error');
}));

test('unknown routes return a 404 JSON body', withServer(async (base) => {
  const res = await fetch(`${base}/nope`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await res.json()).error, 'route not found');
}));

test('GET /api/status/:code returns that exact status', withServer(async (base) => {
  for (const code of [400, 401, 403, 404, 409, 429, 500, 502, 503, 504]) {
    const res = await fetch(`${base}/api/status/${code}`);
    assert.strictEqual(res.status, code, `expected ${code}`);

    const body = await res.json();
    assert.strictEqual(body.simulated, true);
    assert.strictEqual(body.status, code);
    assert.ok(body.statusText.length > 0);
  }
}));

test('GET /api/status/:code rejects a nonsense code with 400', withServer(async (base) => {
  for (const bad of ['abc', '42', '999']) {
    const res = await fetch(`${base}/api/status/${bad}`);
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /between 100 and 599/);
  }
}));

test('break mode makes data endpoints fail, then recovers', withServer(async (base) => {
  // healthy to begin with
  assert.strictEqual((await fetch(`${base}/api/items`)).status, 200);

  const on = await fetch(`${base}/api/break`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 502 })
  });
  assert.strictEqual(on.status, 200);
  assert.deepStrictEqual(await on.json(), {
    broken: true, code: 502, affects: '/api/info, /api/items*, /api/echo'
  });

  // data endpoints now fail with the chosen code
  for (const p of ['/api/items', '/api/info', '/api/echo']) {
    const res = await fetch(`${base}${p}`);
    assert.strictEqual(res.status, 502, `${p} should be 502`);
    assert.strictEqual((await res.json()).breakMode, true);
  }

  // health and the break controls stay reachable
  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  assert.strictEqual((await fetch(`${base}/api/break`)).status, 200);
  assert.strictEqual((await fetch(`${base}/api/status/403`)).status, 403);

  // recover
  const off = await fetch(`${base}/api/break`, { method: 'DELETE' });
  assert.strictEqual(off.status, 200);
  assert.deepStrictEqual(await off.json(), { broken: false, code: null });
  assert.strictEqual((await fetch(`${base}/api/items`)).status, 200);
}));

test('POST /api/break rejects an unsupported code', withServer(async (base) => {
  const res = await fetch(`${base}/api/break`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 123 })
  });
  assert.strictEqual(res.status, 400);
  assert.ok(Array.isArray((await res.json()).simulatable));
}));
