# Extension (Firefox MV3)

## Manifest essentials

- `manifest_version: 3`, background `scripts` (Firefox event page), `browser_specific_settings.gecko.id` set, `strict_min_version: "128.0"`.
- Permissions (the same set WEBCAT uses for this technique): `webRequest`, `webRequestBlocking`, `webRequestFilterResponse`, `storage`, `alarms`, `tabs`, `browsingData`. `host_permissions: ["<all_urls>"]`.
- Bundle with Vite or esbuild into `dist/`. Load in Firefox via `about:debugging` → "Load Temporary Add-on". The `web-ext` CLI is optional.

## Background: sync (owner: Arya, uses `packages/registry`)

1. On install and every 10 minutes (`browser.alarms`): fetch all `policy` entities created by `CURATOR_ADDRESS` (hardcoded in `src/config.ts`). Keep the highest `version` per dapp.
2. For each policy and each allowlisted builder, list `attestation` entities with `.createdBy(builder)` and `dapp == policy.dapp`, selecting **keys and attributes only** (no payload).
3. Fetch the payload only for entity keys not already cached in `storage.local`. Manifests are 3–81 KB gzipped (measured), so a first sync of five dapps × 3 builders × 3 releases is about 1.5 MB, and later syncs download only new releases.
4. Decode each payload and pass `{ creator, attestation, manifest, swarmRef }` entries to `acceptReleases(policy, entries)`, which verifies signatures and roots itself.
5. Store a snapshot in `storage.local`: `{ syncedAt, dapps: { [dapp]: { policy, releases: AcceptedRelease[] } } }`.
6. Clear the HTTP cache for policy origins once after a snapshot changes (`browser.browsingData.remove({ origins }, { cache: true })`), so cached files can't skip verification.
7. **Privacy rule:** browsing activity never triggers a registry request. Sync is time-based and covers every dapp.

## Background: enforcement (owner: Arya)

For every request whose **tab top-level origin** is in a policy:

| Request | Rule |
|---|---|
| Same-origin `main_frame`, `sub_frame`, `script`, `stylesheet`, `worker`, `script`-like `xmlhttprequest` for `.js` | Buffer the full body with `filterResponseData`, hash it, then `checkFile` against the tab's locked release |
| Config file path (in `manifest.config`) | Hash must equal `policy.configPins[path]` **and** `checkConfig` must pass; otherwise `config-invalid` |
| Cross-origin `script` / `worker` | Allowed only if origin + path is pinned in `policy.thirdParty` and the hash matches. Otherwise blocked |
| Anything else (images, fonts, JSON API calls) | Pass through (not code) |

**Release lock:** the first same-origin document (`/` or `/index.html`) picks the release whose manifest contains that exact hash. Every later file in that tab must belong to the same release, otherwise the verdict is `release-mixed`. If no accepted release matches the document, the tab is a `mismatch`.

**filterResponseData pattern:** collect every `ondata` chunk, and in `onstop` concatenate, hash and decide.
- Pass: `filter.write(fullBody)` then `filter.close()`.
- Block anything: write nothing, `filter.close()`. The browser gets an empty file and nothing executes.
- Then, for a blocked `main_frame`, `sub_frame`, `script`, `stylesheet` or `worker`, send the tab to the blocked page: `browser.tabs.update(tabId, { url: browser.runtime.getURL("blocked.html") + "?tab=" + tabId })`. The page is broken anyway, and otherwise the user doesn't know why.
  - This happens once per page load, and only if the tab is still on the page that made the request and that page's own origin is the policy origin. A normal site embedding a policy-origin frame is not taken over.
  - A blocked `xmlhttprequest` for `.js` gets an empty body but stays on the page. The verdict still turns `mismatch`, and the popup's "See details" leads to the blocked page.
  - Responses of that page load that finish after it went to the blocked page are still blocked (nothing is written), but they are not added to `TabState.blocked` or to the kept blocked bodies. Moving the tab aborts their downloads, so what arrives is a cut-off body, not evidence about the release: hashing it would list intact files as `hash-mismatch`. The blocked list therefore shows what was checked before the move, and may miss files still loading then.
  - Likewise, a 0-byte body from a request whose filter errored or was interrupted is blocked but never recorded as `hash-mismatch`: an empty body there means the download failed, not that the server sent an empty file. A complete empty response is checked like any other. The pure rule is `countsAsEvidence` in `navigation.ts`.
- Never forward partial data before the decision.

**Recovery origin:** `swarmRef` is a mirror reference (any static host; verified byte-for-byte), field name kept for compatibility. Requests to `policy.recovery.gateway + swarmRef + "/..."`, which is `gatewayUrl(gateway, ref, path)`, are treated as files of that release, with the path being the part after the ref. They are verified the same way, so an untrusted gateway can't tamper.

**Per-tab state** (in memory, mirrored to `storage.session`): `TabState` from `formats.md` §6. Also keep the first 200 KB of each blocked script body (in memory only) for the diff panel. Reset on top-level navigation.

**Leaving a policy origin:** `webRequest` doesn't fire for `about:` and some other pages, so `tabs.onUpdated` (`changeInfo.url`) also watches the tab. When the URL's origin is not a policy origin, the background resets the record, clears the badge text and removes `tab:<id>` from `storage.session`. That covers `about:`, `file:`, other extension pages and any http(s) origin not in the snapshot. Our own `blocked.html` keeps the state, because it explains that verdict. The reset keeps the new page's origin, because that page's frames classify their scripts against it.

**pushState guard:** while a policy document is loading (`documentPending`), a URL change to a non-policy origin does not reset the record. The page being left is still alive and can call `history.pushState`, which fires `changeInfo.url` with its own non-policy URL. Without the guard, that overwrites the record's origin, the new document's scripts inherit the non-policy origin, and they load without being checked: a tampered script would run. `documentPending` clears when the tab reports a policy-origin URL or `blocked.html`, or when the document's filter errors.

**Messages the background answers:**

| Message | Returns |
|---|---|
| `{ type: "getTabState", tabId }` | `TabState` |
| `{ type: "getSnapshotSummary" }` | `SnapshotSummary` |
| `{ type: "getBlockedBody", tabId, url }` | `{ body: string }` or `{ error: string }` |
| `{ type: "openVerifiedCopy", tabId }` | navigates the tab to `gateway + swarmRef + path` for the locked (or newest) release |

## UI (owner: Yuvraaj)

All UI reads state through the messages above (`browser.runtime.sendMessage`). The UI never computes verdicts.

| Surface | Content |
|---|---|
| Toolbar badge (`browser.action`) | 🟢 "OK" / 🔴 "!" / grey. Colour per verdict level |
| Popup | dapp, release, commit (short), builders who attested (k of n), files checked, accepted config values (e.g. RPC hosts), last sync time. On a `mismatch`: the blocked files and a "See details" button that opens `blocked.html?tab=<id>` in that tab (hidden when the tab is already there) |
| `blocked.html` | Big red header "Blocked: this dapp's code doesn't match its public source". List of blocked files with reason. **Diff panel** for the first blocked script. Buttons: "Open verified copy" (the mirror) and "Go back" |
| Diff panel | Get the blocked body with `getBlockedBody`. Fetch the verified file from the mirror by path (gateway and ref from `getSnapshotSummary`), check its hash against the manifest, pretty-print both with `js-beautify`, show a unified diff (`diff` npm package, `createTwoFilesPatch`). Highlight added lines. Cap at 400 lines |

Blocked files are labelled by path (a third-party script keeps its host). The dapp's `/` and `/index.html` read `/ (start page)` and `/index.html (start page)`; other paths are shown as they are.

Copy tone: plain and calm. Never say "hacked". Say "doesn't match its public source".

## Chrome (stretch, M15)

MV3 Chrome can't read response bodies. Detect-and-warn instead: a content script lists script URLs, re-fetches them, hashes and compares; a MAIN-world script at `document_start` wraps `window.ethereum.request` (and EIP-6963 providers) and holds `eth_sendTransaction` / `eth_signTypedData*` until the verdict is green. State the WebHID/WebUSB gap in the README.

## Acceptance tests (run in Firefox with the demo server)

1. Normal Lido build: badge 🟢, popup shows release 0.161.0 and 3 builders, the page works.
2. `demo attack swap`: one chunk replaced. That script is blocked before execution, the badge turns red, the tab goes to the blocked page, and the blocked page shows the diff.
3. `demo attack inject`: an extra `<script src="http://localhost:9090/evil.js">` is added. Blocked as third-party, and because `index.html` no longer matches.
4. `demo attack hijack`: the whole site is served from the attacker directory. The document is blocked and the blocked page appears.
5. "Open verified copy" loads the mirror copy and it verifies 🟢.
6. Turn the network off after a sync: verdicts still work from the snapshot.
