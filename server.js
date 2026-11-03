// Minimal relay: JanitorAI -> NVIDIA Build (NIM).
// Stores no API key. Your key is sent by Janitor in the Authorization header
// and forwarded as-is, so nobody can use this relay without their own key.
// Logs each request (model, status, time) to Render's Logs tab. Never logs keys or messages.
const http = require('http');
const { Readable } = require('stream');
 
const UPSTREAM = 'https://integrate.api.nvidia.com/v1';
const PORT = process.env.PORT || 3000;
 
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
  const body = Buffer.concat(chunks);
 
  let model = '?', stream = false;
  try { const j = JSON.parse(body.toString() || '{}'); model = j.model || '?'; stream = !!j.stream; } catch {}
 
  const start = Date.now();
  const secs = () => ((Date.now() - start) / 1000).toFixed(1) + 's';
  log(`REQUEST ${req.method} ${req.url} model=${model} stream=${stream}`);
 
  try {
    const upstream = await fetch(UPSTREAM + req.url.slice(3), {
      method: req.method,
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
    log(`FAILED after ${secs()}: ${err.message}`);
    sendJson(res, 502, { error: { message: 'Could not reach NVIDIA: ' + err.message } });
  }
}).listen(PORT, () => log('Relay listening on port ' + PORT));
 
