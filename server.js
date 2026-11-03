// Minimal relay: JanitorAI -> NVIDIA Build (NIM).
// Stores no API key. Your key is sent by Janitor in the Authorization header
// and forwarded as-is, so nobody can use this relay without their own key.
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

http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('OK'); }
  if (!req.url.startsWith('/v1/')) return sendJson(res, 404, { error: { message: 'Not found. Use /v1/chat/completions' } });

  const auth = req.headers['authorization'];
  if (!auth) return sendJson(res, 401, { error: { message: 'Missing API key. Put your nvapi- key in the API key field.' } });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  try {
    const upstream = await fetch(UPSTREAM + req.url.slice(3), {
      method: req.method,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': req.headers['accept'] || 'application/json',
      },
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (err) {
    sendJson(res, 502, { error: { message: 'Could not reach NVIDIA: ' + err.message } });
  }
}).listen(PORT, () => console.log('Relay listening on port ' + PORT));
