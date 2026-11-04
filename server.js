// Minimal relay: JanitorAI -> NVIDIA Build (NIM).
// Stores no API key. Your key is sent by Janitor in the Authorization header
// and forwarded as-is, so nobody can use this relay without their own key.
// Logs each request (model, status, time) to Render's Logs tab. Never logs keys or messages.
//
// Optional Render environment variables:
//   EXTRA_BODY       JSON merged into every request, e.g. to switch thinking off:
//                    {"chat_template_kwargs":{"thinking":false}}
//   TIMEOUT_SECONDS  how long to wait for NVIDIA before giving up (default 600)
const http = require('http');
const { Readable } = require('stream');
const { fetch, Agent } = require('undici');

const UPSTREAM = 'https://integrate.api.nvidia.com/v1';
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = (parseInt(process.env.TIMEOUT_SECONDS, 10) || 600) * 1000;
const dispatcher = new Agent({ headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });

let EXTRA = {};
if (process.env.EXTRA_BODY) {
  try { EXTRA = JSON.parse(process.env.EXTRA_BODY); }
  catch (e) { console.log('EXTRA_BODY is not valid JSON, ignoring it: ' + e.message); }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function log(msg) {
  console.log(new Date().toISOString().slice(11, 19) + ' ' + msg);
}

http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('OK'); }
  if (!req.url.startsWith('/v1/')) return sendJson(res, 404, { error: { message: 'Not found. Use /v1/chat/completions' } });

  const auth = req.headers['authorization'];
  if (!auth) { log('REJECTED: no API key sent'); return sendJson(res, 401, { error: { message: 'Missing API key. Put your nvapi- key in the API key field.' } }); }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);

  let model = '?', stream = false;
  if (req.method === 'POST') {
    try {
      const j = JSON.parse(body.toString() || '{}');
      Object.assign(j, EXTRA);
      model = j.model || '?';
      stream = !!j.stream;
      body = Buffer.from(JSON.stringify(j));
    } catch {}
  }

  const start = Date.now();
  const secs = () => ((Date.now() - start) / 1000).toFixed(1) + 's';
  log(`REQUEST ${req.method} ${req.url} model=${model} stream=${stream}${Object.keys(EXTRA).length ? ' extra=' + JSON.stringify(EXTRA) : ''}`);

  try {
    const upstream = await fetch(UPSTREAM + req.url.slice(3), {
      method: req.method,
      dispatcher,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': req.headers['accept'] || 'application/json',
      },
      body: req.method === 'POST' ? body : undefined,
    });

    log(`NVIDIA answered ${upstream.status} after ${secs()}`);
    if (upstream.status >= 400) {
      const text = await upstream.text();
      log('NVIDIA error: ' + text.slice(0, 300));
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      return res.end(text);
    }

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    });
    if (upstream.body) {
      const s = Readable.fromWeb(upstream.body);
      s.on('end', () => log(`DONE after ${secs()}`));
      s.on('error', (e) => log(`STREAM ERROR after ${secs()}: ${e.message}`));
      res.on('close', () => { if (!res.writableEnded) log(`CLIENT GAVE UP after ${secs()}`); });
      s.pipe(res);
    } else res.end();
  } catch (err) {
    const reason = err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message;
    log(`FAILED after ${secs()}: ${reason}`);
    sendJson(res, 502, { error: { message: 'Could not reach NVIDIA: ' + reason } });
  }
}).listen(PORT, () => log(`Relay listening on port ${PORT}, timeout ${TIMEOUT_MS / 1000}s`));
