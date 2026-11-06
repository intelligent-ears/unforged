// Runs the generated payload (attacker/evil.js) against a fake window + provider and
// checks the chain/origin guard: it rewrites `to` only on the demo chain at the demo
// origin, and is inert everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const CONFIG = JSON.parse(readFileSync(fileURLToPath(new URL('./config.json', import.meta.url)), 'utf8'));
const PAYLOAD = readFileSync(fileURLToPath(new URL('./attacker/evil.js', import.meta.url)), 'utf8');
const CHAIN_HEX = `0x${CONFIG.chainId.toString(16)}`; // 560048 -> 0x88bb0
const WRAPPED = Symbol.for('unforged.demo.wrapped');

function makeProvider(chainHex = CHAIN_HEX) {
  const calls = [];
  return {
    calls,
    request(args) {
      calls.push(args.method);
      if (args.method === 'eth_chainId') return Promise.resolve(chainHex);
      return Promise.resolve('0xok');
    },
  };
}

/** Runs the payload in a vm with a fake browser. Returns helpers to drive it. */
function load(code, { origin = CONFIG.origin, ethereum = undefined } = {}) {
  const listeners = new Map();
  const logs = [];
  const posted = [];
  const window = {
    ethereum,
    location: { origin },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    dispatchEvent(ev) {
      for (const cb of listeners.get(ev.type) ?? []) cb(ev);
      return true;
    },
    // The real content-script sink. The payload wraps this and forwards here.
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  const sandbox = {
    window,
    console: { log: (...a) => logs.push(a.join(' ')) },
    Event: class { constructor(type) { this.type = type; } },
  };
  createContext(sandbox);
  runInContext(code, sandbox);
  function announce(provider) {
    const ev = { type: 'eip6963:announceProvider', detail: { provider } };
    for (const cb of listeners.get('eip6963:announceProvider') ?? []) cb(ev);
  }
  return { logs, announce, window, posted };
}

const CAIP_SCOPE = `eip155:${CONFIG.chainId}`; // eip155:560048

// A MetaMask multichain message: a wallet_invokeMethod wrapping a scoped inner request,
// nested under the content-script stream the way MetaMask posts it.
function multichainMessage(scope, request) {
  return {
    target: 'metamask-contentscript',
    data: {
      name: 'metamask-multichain-provider',
      data: { jsonrpc: '2.0', id: 1, method: 'wallet_invokeMethod', params: { scope, request } },
    },
  };
}

function tx(to = '0xC0ffEE0000000000000000000000000000000000') {
  return { from: '0xdEAD000000000000000000000000000000000000', to, value: '0x1' };
}

test('rewrites `to` on the demo chain at the demo origin', async () => {
  const provider = makeProvider(CHAIN_HEX);
  const { logs } = load(PAYLOAD, { ethereum: provider });
  const params = [tx()];
  await provider.request({ method: 'eth_sendTransaction', params });
  assert.equal(params[0].to, CONFIG.attackerAddress);
  assert.ok(logs.some((l) => l.includes('[unforged demo payload]')));
  assert.equal(provider[WRAPPED], true);
});

test('leaves `to` unchanged on another chain (0x1)', async () => {
  const provider = makeProvider('0x1');
  load(PAYLOAD, { ethereum: provider });
  const params = [tx()];
  const before = params[0].to;
  await provider.request({ method: 'eth_sendTransaction', params });
  assert.equal(params[0].to, before);
});

test('leaves `to` unchanged on another origin, and never asks the chain there', async () => {
  const provider = makeProvider(CHAIN_HEX);
  load(PAYLOAD, { ethereum: provider, origin: 'http://not-the-demo.example' });
  const params = [tx()];
  const before = params[0].to;
  await provider.request({ method: 'eth_sendTransaction', params });
  assert.equal(params[0].to, before);
  assert.ok(!provider.calls.includes('eth_chainId'));
});

test('leaves other methods untouched', async () => {
  const provider = makeProvider(CHAIN_HEX);
  load(PAYLOAD, { ethereum: provider });
  for (const method of ['eth_call', 'personal_sign']) {
    const params = [tx()];
    const before = params[0].to;
    await provider.request({ method, params });
    assert.equal(params[0].to, before);
  }
});

test('wraps a provider announced through EIP-6963', async () => {
  const provider = makeProvider(CHAIN_HEX);
  const { announce } = load(PAYLOAD, { ethereum: undefined });
  announce(provider);
  assert.equal(provider[WRAPPED], true);
  const params = [tx()];
  await provider.request({ method: 'eth_sendTransaction', params });
  assert.equal(params[0].to, CONFIG.attackerAddress);
});

test('never wraps the same provider twice', () => {
  const provider = makeProvider(CHAIN_HEX);
  const { announce } = load(PAYLOAD, { ethereum: provider }); // wrapped once as window.ethereum
  const afterFirst = provider.request;
  announce(provider); // same object, announced via 6963
  announce(provider);
  assert.equal(provider.request, afterFirst);
});

// --- MetaMask multichain channel (window.postMessage) ---

test('rewrites a multichain eth_sendTransaction on the demo scope at the demo origin', () => {
  const { window, logs, posted } = load(PAYLOAD);
  const request = { method: 'eth_sendTransaction', params: [tx()] };
  const message = multichainMessage(CAIP_SCOPE, request);
  window.postMessage(message, CONFIG.origin);
  assert.equal(request.params[0].to, CONFIG.attackerAddress);
  assert.ok(logs.some((l) => l.includes('[unforged demo payload]')));
  assert.equal(posted.length, 1); // still forwarded, once
  assert.equal(posted[0].message, message);
});

test('rewrites every call of a multichain wallet_sendCalls on the demo scope', () => {
  const { window } = load(PAYLOAD);
  const a = tx('0xaaaA000000000000000000000000000000000000');
  const b = tx('0xbBBb000000000000000000000000000000000000');
  const request = { method: 'wallet_sendCalls', params: [{ from: a.from, calls: [a, b] }] };
  window.postMessage(multichainMessage(CAIP_SCOPE, request), CONFIG.origin);
  assert.equal(a.to, CONFIG.attackerAddress);
  assert.equal(b.to, CONFIG.attackerAddress);
});

test('leaves a multichain message on another chain (eip155:1) untouched', () => {
  const { window, posted } = load(PAYLOAD);
  const request = { method: 'eth_sendTransaction', params: [tx()] };
  const before = request.params[0].to;
  window.postMessage(multichainMessage('eip155:1', request), CONFIG.origin);
  assert.equal(request.params[0].to, before);
  assert.equal(posted.length, 1);
});

test('leaves a multichain message on another origin untouched', () => {
  const { window, posted } = load(PAYLOAD, { origin: 'http://not-the-demo.example' });
  const request = { method: 'eth_sendTransaction', params: [tx()] };
  const before = request.params[0].to;
  window.postMessage(multichainMessage(CAIP_SCOPE, request), 'http://not-the-demo.example');
  assert.equal(request.params[0].to, before);
  assert.equal(posted.length, 1);
});

test('passes unrelated postMessages through unchanged', () => {
  const { window, posted } = load(PAYLOAD);
  const unrelated = { type: 'hello', payload: { to: tx().to } };
  const before = unrelated.payload.to;
  window.postMessage(unrelated, CONFIG.origin);
  assert.equal(unrelated.payload.to, before);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message, unrelated);
});
