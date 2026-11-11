// Serves a static build the way GitHub Pages does, so a gh-pages tree can be checked locally.
//
// Usage: node demo/tools/serve-static.mjs <root> [--port 8081]
//
// Clean URLs: "/" and "/dir/" serve index.html, "/dir" redirects to "/dir/", "/page" serves
// page.html, and anything else gets 404.html with status 404. No caching headers are sent.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: serve-static.mjs <root> [--port 8081]';

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

export function contentType(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function kind(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}

/** Joining onto "/" collapses every "..", so the result can't climb out of root. Null if undecodable. */
function cleanPath(urlPath) {
  try {
    return join('/', decodeURIComponent(urlPath.split('?')[0]));
  } catch {
    return null;
  }
}

/**
 * Maps a request path to what GitHub Pages would answer:
 * { status: 200, file } | { status: 301, location } | { status: 404, file | null }.
 */
export function resolveRequest(root, urlPath) {
  const path = cleanPath(urlPath);
  const notFound = () => {
    const page = join(root, '404.html');
    return { status: 404, file: kind(page) === 'file' ? page : null };
  };
  if (path === null) return notFound();

  const target = join(root, path);
  if (urlPath.split('?')[0].endsWith('/')) {
    const index = join(target, 'index.html');
    return kind(index) === 'file' ? { status: 200, file: index } : notFound();
  }
  const found = kind(target);
  if (found === 'file') return { status: 200, file: target };
  // page.html wins over a page/ directory, as Docusaurus with trailingSlash: false expects.
  if (kind(`${target}.html`) === 'file') return { status: 200, file: `${target}.html` };
  if (found === 'dir') return { status: 301, location: `${path}/` };
  return notFound();
}

function respond(root, req, res) {
  const answer = resolveRequest(root, req.url ?? '/');
  if (answer.status === 301) {
    res.writeHead(301, { Location: answer.location }).end();
    return;
  }
  if (answer.file === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n');
    return;
  }
  res.writeHead(answer.status, { 'Content-Type': contentType(answer.file) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(answer.file).pipe(res);
}

function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: '8081' } } });
  const port = Number(values.port);
  if (positionals.length !== 1 || !Number.isInteger(port)) {
    console.error(USAGE);
    process.exit(1);
  }
  const root = resolve(positionals[0]);
  if (kind(root) !== 'dir') {
    console.error(`not a directory: ${root}`);
    process.exit(1);
  }
  createServer((req, res) => respond(root, req, res)).listen(port, () => {
    console.log(`serving ${root} at http://localhost:${port}/`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
