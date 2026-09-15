// Serve a production build from dist/.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT } from './compile.mjs';

const DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4173);
if (!fs.existsSync(DIR)) {
  console.error('dist/ not found - run `npm run build` first.');
  process.exit(1);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
http
  .createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(DIR, path.normalize(p).replace(/^[/\\]+/, ''));
    if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`dist/ served at http://127.0.0.1:${PORT}`));
