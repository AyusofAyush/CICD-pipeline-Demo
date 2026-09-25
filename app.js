const path = require('path');

const express = require('express');

const pkg = require('./package.json');

// Flip this to "true" (env var) to simulate a bad deploy during the rollback demo.
const BREAK_HEALTH = process.env.BREAK_HEALTH === 'true';

const STARTED_AT = Date.now();

// Error codes the demo can simulate on demand.
const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
};
const SIMULATABLE = Object.keys(STATUS_TEXT).map(Number);

function meta() {
  return {
    version: pkg.version,
    commit: process.env.COMMIT_SHA || 'local',
    buildId: process.env.BUILD_ID || 'local',
    revision: process.env.K_REVISION || 'local',
    service: process.env.K_SERVICE || 'demo-project',
    region: process.env.APP_REGION || 'local',
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    timestamp: new Date().toISOString()
  };
}

function createApp() {
  const app = express();
  app.use(express.json());

  // In-memory store. Resets on every new revision - that is the point:
  // Cloud Run containers are stateless and disposable.
  // null = healthy; otherwise every data endpoint returns this status code.
  let breakCode = null;

  let nextId = 3;
  let items = [
    { id: 1, name: 'Build the image', done: true },
    { id: 2, name: 'Deploy to Cloud Run', done: false }
  ];

  // Log every request so the Cloud Run LOGS tab has something to show.
  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(JSON.stringify({
        severity: res.statusCode >= 500 ? 'ERROR' : 'INFO',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        revision: process.env.K_REVISION || 'local'
      }));
    });
    next();
  });

  // Break-mode gate: applies to the data endpoints only, so /health and the
  // break controls themselves always stay reachable.
  app.use((req, res, next) => {
    if (breakCode === null) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/break' || req.path.startsWith('/api/status/')) return next();
    return res.status(breakCode).json({
      error: STATUS_TEXT[breakCode] || 'Error',
      status: breakCode,
      breakMode: true,
      hint: 'DELETE /api/break to recover',
      ...meta()
    });
  });

  // ---- HTML dashboard: renders itself from the APIs below ----
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  // ---- Health: the endpoint Cloud Run and the rollback demo care about ----
  app.get('/health', (req, res) => {
    if (BREAK_HEALTH) {
      return res.status(500).json({
        status: 'error',
        error: 'BREAK_HEALTH is enabled',
        ...meta()
      });
    }
    return res.status(200).json({ status: 'ok', ...meta() });
  });

  // ---- Service metadata ----
  app.get('/api/info', (req, res) => {
    res.json({
      ...meta(),
      node: process.version,
      env: process.env.NODE_ENV || 'development'
    });
  });

  // ---- Items CRUD, enough surface to prove the deploy really changed ----
  app.get('/api/items', (req, res) => {
    res.json({ count: items.length, items });
  });

  app.get('/api/items/:id', (req, res) => {
    const item = items.find((i) => i.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'not found', id: req.params.id });
    return res.json(item);
  });

  app.post('/api/items', (req, res) => {
    const name = (req.body && req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const item = { id: nextId++, name, done: false };
    items.push(item);
    return res.status(201).json(item);
  });

  app.delete('/api/items/:id', (req, res) => {
    const id = Number(req.params.id);
    const before = items.length;
    items = items.filter((i) => i.id !== id);
    if (items.length === before) return res.status(404).json({ error: 'not found', id });
    return res.status(204).end();
  });

  // ---- Echo: handy for showing request/response wiring live ----
  app.get('/api/echo', (req, res) => {
    res.json({ youSent: req.query, ...meta() });
  });

  // ---- Error simulation -------------------------------------------------
  // One-off: return any status code on demand.  GET /api/status/403
  app.get('/api/status/:code', (req, res) => {
    const code = Number(req.params.code);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      return res.status(400).json({
        error: 'code must be an integer between 100 and 599',
        received: req.params.code,
        simulatable: SIMULATABLE
      });
    }
    const label = STATUS_TEXT[code] || 'Simulated Response';
    if (code >= 400) {
      console.error(JSON.stringify({
        severity: code >= 500 ? 'ERROR' : 'WARNING',
        msg: 'simulated ' + code + ' ' + label,
        revision: process.env.K_REVISION || 'local'
      }));
    }
    return res.status(code).json({
      simulated: true,
      status: code,
      statusText: label,
      ...meta()
    });
  });

  // Back-compat shorthand for the most common case.
  app.get('/api/error', (req, res) => {
    console.error(JSON.stringify({ severity: 'ERROR', msg: 'deliberate test error' }));
    res.status(500).json({ error: 'deliberate test error', ...meta() });
  });

  // Sticky break mode: make the data endpoints keep failing until reset.
  app.get('/api/break', (req, res) => {
    res.json({ broken: breakCode !== null, code: breakCode, simulatable: SIMULATABLE });
  });

  app.post('/api/break', (req, res) => {
    const code = Number((req.body && req.body.code) || 500);
    if (!SIMULATABLE.includes(code)) {
      return res.status(400).json({ error: 'unsupported code', simulatable: SIMULATABLE });
    }
    breakCode = code;
    console.error(JSON.stringify({
      severity: 'ERROR',
      msg: 'break mode ENABLED, data endpoints now return ' + code,
      revision: process.env.K_REVISION || 'local'
    }));
    return res.json({ broken: true, code: breakCode, affects: '/api/info, /api/items*, /api/echo' });
  });

  app.delete('/api/break', (req, res) => {
    breakCode = null;
    console.log(JSON.stringify({ severity: 'INFO', msg: 'break mode disabled' }));
    res.json({ broken: false, code: null });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'route not found', path: req.path });
  });

  return app;
}

module.exports = { createApp };
