import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const PUBLIC = 'public';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.geojson': 'application/json', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  // Serve public/ at the root, but let the fixture reach ../extension/.
  const rel = path.startsWith('/extension/') ? path.slice(1) : join(PUBLIC, path === '/' ? 'index.html' : path);
  const file = join(ROOT, rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  }
}).listen(Number(process.env.PORT ?? 8790), function () { console.log("http://localhost:" + this.address().port); });
