# FlagSwap architecture

Internals for contributors and auditors: file layout, how the interception
actually works, what it doesn't cover, and where the implementation diverges
from its original design. If you just want to install and use FlagSwap, see
the [README](README.md).

---

## File tree

```
FlagSwap/
├── LICENSE                  # MIT
├── ARCHITECTURE.md          # This file.
├── CLAUDE.md
├── README.md
├── manifest.base.json       # Shared MV3 manifest (content scripts + host_permissions for LD API)
├── manifest.chrome.json     # Chromium overlay (service_worker, sidePanel)
├── manifest.firefox.json    # Firefox overlay (background scripts, sidebar, containers)
├── package.json             # npm test / e2e / e2e:tier2 / smoke:ld / build / package scripts
├── src/
│   ├── core.js              # PURE interception logic (UMD: Node + browser). All interception business logic.
│   ├── inject.js            # MAIN world: wraps fetch + EventSource + XMLHttpRequest. Thin glue over core.
│   ├── bridge.js            # ISOLATED world: chrome.storage -> CustomEvent -> MAIN world.
│   ├── banner.js            # ISOLATED world: on-page override banner + toolbar badge count.
│   ├── state.js             # PURE storage-schema normalization + override resolution (UMD).
│   ├── ldapi.js             # PURE LD REST API shaping (UMD: Node + browser/SW). Unit-testable.
│   ├── background.js        # Service worker: the ONLY place LD API calls + token handling happen.
│   ├── popup.html/.css/.js  # Popup + side panel UI (flag list, overrides, groups).
│   ├── options.html/.css/.js# Options page (LD connection, profiles, containers, settings).
│   └── icons/               # Extension icons + source SVGs.
├── docs/                    # GitHub Pages source — everything here is PUBLISHED.
│   └── privacy.html         # Published privacy policy.
├── notes/
│   └── chrome-store-submission.md  # Internal store-submission worksheet (not published).
├── demo/
│   ├── index.html           # Loads real LD client SDK v3 (public demo env); the tier-1 demo page.
│   └── tier2.html           # useReport + streaming transport probe (tier-2 trial env).
├── scripts/
│   ├── build.mjs            # Writes dist/chrome/ and dist/firefox/ from src/ + manifests.
│   ├── package.mjs          # Zips the built targets for store upload.
│   ├── gen-icons.mjs        # Renders the PNG icon set from the source SVG.
│   └── ld-smoke.mjs         # Live LD API smoke test (reads LD_TOKEN from env; never hardcoded).
└── test/
    ├── core.test.js         # Interception unit tests (node:test).
    ├── ldapi.test.js        # LD API shaping unit tests (normalize/paginate/backoff).
    ├── state.test.js        # Storage-schema + override-resolution unit tests.
    ├── e2e.spec.mjs         # Tier-1 Playwright E2E: override reflected in rendered DOM.
    ├── e2e-tier2.spec.mjs   # Tier-2 E2E: useReport/XHR transport coverage.
    └── fixtures/
        ├── eval.json        # REAL captured poll/`put` payload from the public LD demo env.
        ├── patch.json       # Hand-authored SSE `patch` fixture.
        ├── projects.json    # LD /projects?expand=environments fixture (2 projects, multi-env, fake IDs).
        ├── flags.json       # LD /flags page 1 (boolean + multivariate + server-side + _links.next).
        └── flags-page2.json # LD /flags page 2 (legacy includeInSnippet + archived; exercises pagination).
```

---

## Permissions / match patterns

`manifest.base.json` uses a broad `*://*/*` match so the wrappers install on any
page that might host the LD SDK — LD-powered apps live on arbitrary and changing
hosts (localhost, staging subdomains, per-customer production domains), and the
demo is served from localhost. Interception only *activates* on pages that
actually evaluate LD flags; everywhere else the wrappers are pass-through. If you
build for a fixed set of origins, narrowing the match is the safer choice.

`host_permissions` grants LaunchDarkly's REST API hosts —
`https://app.launchdarkly.com/*`, with `https://app.eu.launchdarkly.com/*` and
`https://app.launchdarkly.us/*` for the EU and US-federal instances, selectable
in the options page. They are used **only** by the optional flag-list sync in the
service worker; the interception path uses no credentials and no host permission
at all.

---

## LD API token security model

- The token is stored in `chrome.storage.local` under `flagswap:ldToken` (base
  URL under `flagswap:ldBaseUrl`). **Unencrypted** — Chrome local storage has no
  at-rest encryption. Use a Reader-scoped token and revoke it when done.
- **All** LD API calls happen in the **service worker** (`src/background.js`),
  which reads the token from storage per-call. The token is **never** sent to a
  content script, to MAIN-world `inject.js`, or in any message page JS can see.
  The popup talks to the SW via `chrome.runtime.sendMessage` and gets back flag
  **data only**. (Verified: with a token saved, the string never appears in a web
  page's MAIN world.)
- API specifics: base `https://app.launchdarkly.com/api/v2` (+ EU/US), auth is
  the **raw token** (no `Bearer`), always `LD-API-Version: 20240415`. Pagination
  follows `_links.next.href` serialized (no parallel fan-out); 429s back off
  (Retry-After / X-Ratelimit-Reset, else exponential).

---

## Interception design

```
  page JS (MAIN world)          extension content scripts
  ┌───────────────────┐
  │  LaunchDarkly SDK  │
  │   fetch / ES       │
  └─────────┬─────────┘
            │ wrapped by
  ┌─────────▼─────────┐         ┌──────────────────────────┐
  │  inject.js (MAIN, │◄────────│  bridge.js (ISOLATED,    │
  │  document_start)  │ Custom  │  document_start)         │
  │  wraps fetch +    │ Event   │  reads chrome.storage,   │
  │  EventSource;     │ 'flag-  │  pushes overrides +      │
  │  applies overrides│ swap:   │  re-pushes onChanged     │
  │  via core.js      │ over-   │                          │
  └─────────┬─────────┘ rides'  └──────────────────────────┘
            │ uses                          ▲
  ┌─────────▼─────────┐                     │ chrome.storage.local
  │  core.js (UMD)    │            ┌─────────┴─────────┐
  │  pure functions   │            │  popup.js (UI)    │
  └───────────────────┘            └───────────────────┘
```

1. **MAIN-world injection at `document_start`.** `src/inject.js` is registered
   with `"world":"MAIN"`, `"run_at":"document_start"` so it wraps the page's
   `fetch` and `EventSource` **before** the LD SDK loads. `core.js` is listed
   first in the same content-script entry so `window.__FlagSwapCore` exists when
   `inject.js` runs.

2. **ISOLATED bridge.** MAIN world has **no** access to `chrome.*`. `src/bridge.js`
   runs in the default (ISOLATED) world, reads `chrome.storage.local`, and pushes
   overrides into MAIN via `CustomEvent('flagswap:overrides', {detail})`. It
   re-pushes on `chrome.storage.onChanged`, and **always pushes at least once**
   (even with zero overrides) to release the readiness gate.

3. **All three transports wrapped.**
   - **Polling (`XMLHttpRequest`) — the PRIMARY path.** The LD JS client SDK v3
     actually sends its eval/poll over **XHR**, not fetch (verified: GET
     `…/contexts/<ctx>` and the `useReport:true` REPORT `…/context` both arrive
     as XHR). `window.XMLHttpRequest` is replaced with a proxy class that wraps a
     native XHR. For non-LD-eval URLs it is a **transparent pass-through**; for
     LD eval URLs it parses the response, runs `applyOverridesToMap`, and surfaces
     the rewritten body through both `responseText` and `response` (the latter
     returns the parsed object for `responseType:'json'`). Terminal events
     (`load`/`loadend`/`readystatechange`@DONE) are deferred behind the readiness
     gate. On any parse failure it falls back to the untouched native response.
   - **Polling (`fetch`):** kept as a defensive path for other SDK
     versions/vendors that poll via fetch. If the URL matches `isLDEvalUrl`, the
     real response is fetched, its JSON body run through `applyOverridesToMap`,
     and a new `Response` with the rewritten body is returned. (Not exercised by
     LD SDK v3, which uses XHR.)
   - **Streaming (`EventSource`):** LD's default. The raw SSE byte stream can't
     be edited, so `window.EventSource` is replaced with a wrapper class. A real
     native `EventSource` does the network/parsing; the wrapper intercepts
     `addEventListener('put'|'patch'|'message'|...)` and the `on<event>`
     handler properties, and when an event fires it parses `event.data`, applies
     overrides, and invokes the page's listener with a **synthetic
     `MessageEvent`** carrying the rewritten data. Both **named** SSE events and
     the default **`message`** event are handled.

4. **Override enforcement at the wrapper layer (in `core.js`):**
   - On poll response and SSE `put` (full map): for each enabled override, set
     `value` (+ `variation` if specified) and **bump `version`** to a large
     constant (`BUMP = 2_000_000_000`) so later real patches at normal versions
     lose the SDK's `version >` check.
   - On SSE `patch` (single flag): if the patch targets an overridden flag,
     rewrite `value`/`variation` and keep a high `version` so a real patch can't
     revert the override. Non-targeted patches pass through untouched.

5. **Storage-load race closed.** The MAIN wrapper holds a `readyPromise` and
   `await`s it before resolving any intercepted response or stream event, so the
   SDK can never initialize with un-overridden values. The bridge signals
   readiness even when there are zero overrides; a 3s safety timeout releases the
   gate if the bridge never fires (extension disabled mid-navigation).

6. **Pure core in a UMD module.** `src/core.js` exports
   `applyOverridesToMap`, `applyOverrideToPatch`, `isLDEvalUrl`, `isLDStreamUrl`,
   `bumpVersion`, and the `BUMP` constant. It works in Node (`module.exports`,
   used by tests) and in the browser (`window.__FlagSwapCore`, used by
   `inject.js`). All business logic lives here; `inject.js`/`bridge.js` are glue.

### Overrides data model

`chrome.storage.local["flagswap:overrides"]`:

```jsonc
{
  "client-side-flag-2-always-green": { "value": "red", "variation": 0, "enabled": true }
}
```

Only `enabled: true` entries apply. `variation` is optional.

---

## Known limitations / coverage gaps (honest)

- **Server-side-rendered / server-side-evaluated flags are uninterceptable.** This
  only touches the client SDK's network traffic. Flags evaluated on the server
  and baked into HTML/API responses are out of scope.
- **Bootstrap-from-localStorage / `bootstrap` option not handled.** If the host
  app initializes the SDK with `bootstrap: 'localStorage'` or an inline
  `bootstrap` object, those initial values never hit `fetch`/`EventSource` and so
  are not overridden until the first network refresh. Not yet handled.
- **`delete` SSE events pass through.** We handle `put` and `patch`. `delete` is
  intentionally pass-through: an override-protected flag holds a `BUMP` version, so
  a normal-version `delete` is ignored by the SDK's version check anyway. A
  malicious/high-version delete would still remove the flag — not covered.
- **REPORT-verb / `useReport:true` — NOW COVERED.** Verified against a real LD
  trial env. With `useReport:true` the SDK opens a **ping** stream
  (`clientstream…/ping/<env>`, which carries no flag data) and fetches flags via
  a **REPORT** request over **XMLHttpRequest** (`…/evalx/<env>/context`). The XHR
  wrapper rewrites that REPORT response (it keys off the URL via `isLDEvalUrl`,
  not the verb), so the override holds in both GET and REPORT modes. See
  `test/e2e-tier2.spec.mjs` — the hard gate asserts `flag-test="false"` in both.
- **`responseType:'json'` for XHR — handled.** `response` returns the rewritten
  parsed object; `responseText` returns the rewritten string. Other response
  types (`arraybuffer`/`blob`/`document`) are passed through untouched (LD eval
  doesn't use them).
- **Synchronous XHR (`open(..., async=false)`) — partial.** The rewritten body
  IS available synchronously (the rewrite is computed during the native terminal
  event, before `send()` returns, so a post-`send()` read of `responseText`
  reflects the override). However the wrapper defers the `load`/DONE *events*
  behind a Promise (the readiness gate), which is inherently async — so a sync
  XHR that relies on the `onload` callback rather than reading after `send()`
  would not see the rewrite via the event. LD's browser SDK uses async XHR, so
  this corner is not hit in practice; noted for honesty.
- **XHR response headers are not rewritten.** `getAllResponseHeaders`/
  `getResponseHeader` forward the native values, so `content-length` still
  describes the ORIGINAL body while `responseText`/`response` return the
  (possibly longer/shorter) rewritten body. The SDK reads the body, not the
  length, so this is harmless here, but it is an inconsistency (the fetch path
  deletes those headers; the XHR path does not need to since it never constructs
  a Response).
- **Storage-race mitigation is best-effort.** The readiness gate + 3s timeout
  closes the common case, but a pathological ordering (SDK reading a cached value
  synchronously before any network) is not provably covered.
- **`event.target`/`source` fidelity on synthetic events.** Synthetic
  `MessageEvent`s carry `data`, `lastEventId`, `origin`, and `type`, but not a
  live `source`/`target` reference. LD's SDK only reads `data`, so this is fine in
  practice but is a deviation from a perfectly faithful event.
- **Broad `*://*/*` match.** Required to reach apps on arbitrary hosts; narrow it
  if you deploy against a known, fixed set of origins.

### LD flag-list sync — coverage gaps (honest)

- **Not exercised against a live token in this workspace.** No LD token was
  available here, so the SW's real HTTP path (auth header acceptance, real
  pagination depth, the actual `clientSideAvailability` shape on live flags, 429
  backoff) is **unverified live**. What IS verified: the pure shaping logic
  (covered by the unit suite against realistic fixtures), the SW loads and routes messages,
  the no-token/no-args error paths, token storage + non-leakage to page context,
  and the full popup rendering (boolean/multivariate/server-side) + override
  persistence from a seeded cache. **Run `LD_TOKEN=… npm run smoke:ld` to close
  the live gap.**
- **Token stored unencrypted.** Chrome `storage.local` is not encrypted at rest.
  Mitigated by Reader-scope guidance + a Forget button + the honest in-UI note;
  not solved.
- **Pagination max is a guess.** Default page size 20; we follow `_links.next`
  serialized up to a safety cap of 100 pages. The real max-per-page and whether
  very large flag sets paginate exactly as assumed are unverified without a live
  account with many flags.
- **Server-side filter relies on the documented field.** We treat a flag as
  interceptable iff `clientSideAvailability.usingEnvironmentId===true` (legacy
  `includeInSnippet===true`). Correct per docs and fixtures; not confirmed against
  a live flag that is genuinely server-side-only.
- **Override value vs flag type is trusted, not validated.** The popup writes the
  variation's `value` as-is; it does not re-check that a multivariate value still
  exists if the flag definition changes between syncs.
- **No live re-sync on flag changes.** Synced data is a cache; there's no stream
  from the LD API to auto-update the popup when flags change in LD (use Refresh).

---

## Deviations from the prescribed architecture

- **`src/background.js` started minimal, now hosts the LD API layer.** It was
  originally added just to give the extension a stable service-worker
  registration (so Playwright could discover the extension ID). The flag-list
  sync feature put it to its intended use: it is now the sole, isolated home for
  LD REST calls + token handling. **All interception still lives in the content
  scripts** — the SW touches neither `inject.js` nor the override-wrapping path.
- **`npm test` lists files explicitly** (`test/core.test.js test/ldapi.test.js`)
  rather than a bare `node --test`. A bare run also discovers the `*.spec.mjs`
  E2E files, which need `xvfb` + a headed browser and would fail/hang in a plain
  `npm test`. The unit gate stays deterministic; E2E lives behind `npm run e2e`
  / `npm run e2e:tier2`.
- **Popup init is cache-first.** On open it renders cached real flags for the
  saved project/env from storage *before* (and independent of) the live
  `ld:projects` call, so the popup shows real flags instantly and even works with
  an expired token / offline. This is an addition beyond the spec's "cache for
  instant reopen", motivated by a failure observed in testing where a bad token
  blanked the list.

---

## E2E test internals

The E2E:
1. launches Chromium with the unpacked extension (`--load-extension`),
2. seeds an override (`always-green` → `red`) into `chrome.storage.local` from
   the extension's own popup page (where `chrome.*` is available),
3. serves `demo/index.html` over http and opens it,
4. asserts the rendered DOM cell shows `red` and **not** `green`.

**Status here: ran and PASSED.** Verified non-trivial via a negative control —
seeding a different sentinel value makes the test fail (the page renders LD's
real `green`), confirming the assertion truly depends on the interception.

Prereqs: `npm i -D playwright` and `npx playwright install chromium` (both done
in this workspace). MV3 extensions require a **headed** browser, so the script
launches `headless:false` under `xvfb-run` (no display needed on the box).
