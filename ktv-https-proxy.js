const http = require('http');

const FUNNEL_PORT = 8444;
const BACKEND_PORT = 3001;
const BACKEND_HOST = '127.0.0.1';
const PATH_PREFIX = '/ktv'; // mirrors old nginx /ktv/ prefix routing

// ── Port Guard: 确保 8444 没被别的进程抢走 ──────────────────────────────
const net = require('net');
const serverTest = net.createServer();
serverTest.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${FUNNEL_PORT} already in use — Funnel cannot bind. Exiting.`);
    process.exit(1);
  }
});
serverTest.listen(FUNNEL_PORT, '0.0.0.0', () => {
  serverTest.close(() => {
    startProxy();
  });
});

function startProxy() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Funnel HTTPS Proxy starting: ${FUNNEL_PORT} -> ${BACKEND_HOST}:${BACKEND_PORT}`);

  const proxy = http.createServer((req, res) => {
    const start = Date.now();
    const reqId = Math.random().toString(36).slice(2, 8);
    console.log(`[${new Date().toISOString()}] [${reqId}] ${req.method} ${req.url} -> ${BACKEND_HOST}:${BACKEND_PORT}`);

    const options = {
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      path: req.url.startsWith(PATH_PREFIX)
        ? req.url.slice(PATH_PREFIX.length) || '/'
        : req.url,
      method: req.method,
      headers: { ...req.headers, 'X-Forwarded-For': req.socket.remoteAddress }
    };

    const r = http.request(options, (pr) => {
      console.log(`[${new Date().toISOString()}] [${reqId}] -> ${pr.statusCode} (${Date.now() - start}ms)`);
      res.writeHead(pr.statusCode, pr.headers);
      pr.pipe(res);
    });

    r.on('error', (e) => {
      console.error(`[${new Date().toISOString()}] [${reqId}] BACKEND_ERROR: ${e.message}`);
      res.writeHead(502);
      res.end('KTV backend unreachable');
    });

    req.pipe(r);
  });

  proxy.on('error', (e) => {
    console.error(`[${new Date().toISOString()}] PROXY_ERROR: ${e.message}`);
  });

  proxy.listen(FUNNEL_PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] Proxy ready: ${FUNNEL_PORT} -> ${BACKEND_HOST}:${BACKEND_PORT}`);
  });
}
