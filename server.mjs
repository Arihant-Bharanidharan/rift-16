import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const portArgument = process.argv.indexOf('--port');
const PORT = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav'
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/audio-worklet.js') {
      const [core, processor] = await Promise.all([
        readFile(path.join(ROOT, 'src', 'dsp-core.cjs'), 'utf8'),
        readFile(path.join(ROOT, 'src', 'worklet-processor.js'), 'utf8')
      ]);
      response.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      response.end(`${core}\n\n${processor}`);
      return;
    }

    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const filename = path.resolve(ROOT, `.${pathname}`);
    if (filename !== ROOT && !filename.startsWith(`${ROOT}${path.sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const body = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
  } catch (error) {
    response.writeHead(error && error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error && error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RIFT/16 running at http://127.0.0.1:${PORT}`);
});
