/* 아주 작은 정적 파일 서버 (테스트 전용 · 127.0.0.1 에만 열어요)
   mounts: [{prefix:'/', dir:'/repo'}, {prefix:'/__npm/', dir:'/node_modules'}] · 긴 prefix 가 먼저 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export function startServer(mounts, port = 0, host = '127.0.0.1') {
  const ms = mounts.slice().sort((a, b) => b.prefix.length - a.prefix.length);
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const m = ms.find(m => p.startsWith(m.prefix));
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    let rel = p.slice(m.prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const f = path.resolve(m.dir, rel);
    if (!f.startsWith(path.resolve(m.dir))) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve({ server: srv, port: srv.address().port, url: `http://${host}:${srv.address().port}`, close: () => new Promise(r => srv.close(() => r())) }));
  });
}
