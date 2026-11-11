// Path mapping and content types for serve-static, against a small tree in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, resolveRequest } from './serve-static.mjs';

function makeTree({ with404 = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'serve-static-'));
  for (const file of ['index.html', 'about.html', 'docs/index.html', 'docs/intro.html', 'assets/app.js']) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), file);
  }
  if (with404) writeFileSync(join(root, '404.html'), 'missing');
  return root;
}

test('/ and /dir/ serve index.html', (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true }));
  assert.deepEqual(resolveRequest(root, '/'), { status: 200, file: join(root, 'index.html') });
  assert.deepEqual(resolveRequest(root, '/docs/'), { status: 200, file: join(root, 'docs/index.html') });
  assert.deepEqual(resolveRequest(root, '/docs/?q=1'), { status: 200, file: join(root, 'docs/index.html') });
});

test('a directory without its slash redirects, like GitHub Pages', (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true }));
  assert.deepEqual(resolveRequest(root, '/docs'), { status: 301, location: '/docs/' });
});

test('page.html wins over a page/ directory of the same name', (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true }));
  writeFileSync(join(root, 'docs.html'), 'docs page');
  assert.deepEqual(resolveRequest(root, '/docs'), { status: 200, file: join(root, 'docs.html') });
  assert.deepEqual(resolveRequest(root, '/docs/'), { status: 200, file: join(root, 'docs/index.html') });
});

test('an extensionless path serves <path>.html, an exact file serves itself', (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true }));
  assert.deepEqual(resolveRequest(root, '/about'), { status: 200, file: join(root, 'about.html') });
  assert.deepEqual(resolveRequest(root, '/docs/intro'), { status: 200, file: join(root, 'docs/intro.html') });
  assert.deepEqual(resolveRequest(root, '/assets/app.js'), { status: 200, file: join(root, 'assets/app.js') });
});

test('anything else gets 404.html with status 404', (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true }));
  const notFound = { status: 404, file: join(root, '404.html') };
  assert.deepEqual(resolveRequest(root, '/nope'), notFound);
  assert.deepEqual(resolveRequest(root, '/assets/'), notFound); // a dir with no index.html
  assert.deepEqual(resolveRequest(root, '/%E0%A4%A'), notFound); // undecodable
});

test('with no 404.html the 404 has no file', (t) => {
  const root = makeTree({ with404: false });
  t.after(() => rmSync(root, { recursive: true }));
  assert.deepEqual(resolveRequest(root, '/nope'), { status: 404, file: null });
});

test('.. cannot climb out of root', (t) => {
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true }));
  assert.deepEqual(resolveRequest(join(root, 'docs'), '/../about.html'), { status: 404, file: null });
  assert.deepEqual(resolveRequest(join(root, 'docs'), '/%2e%2e/about.html'), { status: 404, file: null });
});

test('content types', () => {
  assert.equal(contentType('/a/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('/a.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/a.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('/a.json'), 'application/json');
  assert.equal(contentType('/a.svg'), 'image/svg+xml');
  assert.equal(contentType('/a.png'), 'image/png');
  assert.equal(contentType('/a.woff2'), 'font/woff2');
  assert.equal(contentType('/sitemap.xml'), 'application/xml');
  assert.equal(contentType('/CNAME'), 'application/octet-stream');
});
