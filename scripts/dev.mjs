// Development server: incremental in-process TypeScript compile + static file
// host. No bundler, no child processes, no external services.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, compileOnce, copyStatic, watchBuild } from './compile.mjs';

const OUT = path.join(ROOT, '.dev');
const PORT = Number(process.env.PORT || 5173);

fs.rmSync(OUT, { recursive: true, force: true });
const first = compileOnce(OUT);
if (!first.ok) {
  console.error('\nInitial compile failed. Fix the errors above; the watcher will pick up changes.');
}
copyStatic(OUT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const resolved = path.join(OUT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!resolved.startsWith(OUT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

let building = false;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  CubeWorld dev server ready:  http://127.0.0.1:${PORT}\n`);
  console.log('  Watching src/ for changes (incremental TypeScript compile).');
  console.log('  Press Ctrl+C to stop.\n');
});

watchBuild(OUT, () => {
  if (building) return;
  building = true;
  setTimeout(() => {
    building = false;
    copyStatic(OUT);
    console.log(`  [${new Date().toLocaleTimeString()}] rebuilt`);
  }, 30);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
