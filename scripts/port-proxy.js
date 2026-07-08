#!/usr/bin/env node

const http = require('http');

const listenPort = Number(process.env.PROXY_PORT || 3000);
const targetPort = Number(process.env.PROXY_TARGET_PORT || 3999);

const server = http.createServer((req, res) => {
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `localhost:${targetPort}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy error: ${err.message}`);
  });

  req.pipe(proxyReq);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`[port-proxy] listening on ${listenPort} -> ${targetPort}`);
});
