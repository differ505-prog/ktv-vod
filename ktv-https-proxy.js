const https = require('https');
const http = require('http');

const opts = {
  key: require('fs').readFileSync('/tmp/ts-cert.key'),
  cert: require('fs').readFileSync('/tmp/ts-cert.crt')
};

const ktvProxy = http.createServer((req, res) => {
  const r = http.request({ host: '127.0.0.1', port: 3003, path: req.url, method: req.method, headers: req.headers }, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  req.pipe(r);
  r.on('error', (e) => { res.writeHead(502); res.end('KTV unreachable'); });
});

https.createServer(opts, (req, res) => {
  const r = http.request({ host: '127.0.0.1', port: 3003, path: req.url, method: req.method, headers: req.headers }, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  req.pipe(r);
  r.on('error', (e) => { res.writeHead(502); res.end('KTV unreachable'); });
}).listen(8444, '0.0.0.0', () => console.log('HTTPS:8444 -> 3003/ktv'));
