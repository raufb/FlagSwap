# FlagSwap

An MV3 browser extension (Chrome/Edge/Brave and Firefox) that **overrides
LaunchDarkly client-side feature flags** in the browser by intercepting the
LaunchDarkly JS client SDK. Built for QA engineers and developers who need to
see a feature in a specific on/off state without touching flag configuration.

Overrides are local and read-only: they rewrite the flag-evaluation response as
it arrives in *your* browser and can never change real flag state or affect
anyone else. See [Safety / how it works](#safety--how-it-works).

MIT-licensed — see [LICENSE](LICENSE). For the file layout, interception
internals, and known limitations, see [ARCHITECTURE.md](ARCHITECTURE.md).

The bundled demo page runs against LaunchDarkly's shared **public demo**
environment (`5cc8a87be4b564081fd2fd70`), which needs no account. That ID is
LaunchDarkly's own published demo identifier, not a customer's, so it is checked
in deliberately — the demo cannot work without it. Client-side IDs are public by
design (they ship in the page bundle of every app that loads the SDK), but the
fixtures under `test/fixtures/` still use obviously-fake patterned IDs so no
real environment is implied by test data.

---

## How to load the extension (manual)

First build the per-browser targets (one shared `src/`, separate manifests):

```
npm run build      # writes dist/chrome/ and dist/firefox/
```

**Chrome / Edge / Brave / other Chromium:**
1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select **`dist/chrome`**.

**Firefox (128+ — required for `world: "MAIN"` content scripts):**
- Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick **`dist/firefox/manifest.json`**. (Temporary add-ons clear on restart; for a persistent install the build must be signed via AMO.)
- Validate the build anytime with `npm run lint:firefox` (Mozilla's `addons-linter`).

Then, in either browser:
4. Open `demo/index.html` over **http** (not `file://`, the SDK needs an http
   origin). Quickest:
   ```
   cd /home/user/Projects/FlagSwap/demo && python3 -m http.server 8080
   ```
   then visit `http://localhost:8080/`.
5. Click the FlagSwap toolbar icon to open the popup. Enable an override (e.g.
   set `always-green` to `red`, or flip `always-true` to false).
6. **Reload the demo tab.** The rendered flag table should now show your
   overridden value instead of LD's real value. (Live re-push on storage change
   works for streaming `put`/`patch`, but reloading is the reliable demo.)

### Permissions / match patterns

`manifest.base.json` matches `*://*/*` because LD-powered apps run on arbitrary,
changing hosts (localhost, staging subdomains, per-customer production domains);
interception only *activates* on pages that actually evaluate LD flags.
`host_permissions` grants LaunchDarkly's three REST API hosts (commercial, EU,
US-federal), used only by the optional flag-list sync — the interception path
itself uses no credentials and no host permission at all. Full rationale in
[ARCHITECTURE.md](ARCHITECTURE.md#permissions--match-patterns).

---

## LaunchDarkly flag-list sync (real flags in the popup)

Instead of the hardcoded demo flags, you can connect a **Reader-scoped** LD API
token and drive the override UI from your real projects/envs/flags: key
autocomplete, multivariate variation pickers, auto-detected client-side ID, and
server-side-only flags shown disabled.

The token is stored in `chrome.storage.local`, unencrypted, and every LD API
call happens in the service worker — it is never sent to a content script or to
page JS. Use a Reader-scoped token and revoke it when done. Full handling detail
in [ARCHITECTURE.md](ARCHITECTURE.md#ld-api-token-security-model).

### (a) Create a Reader token

1. LaunchDarkly → **Account settings → Authorization → Access tokens → Create
   token**.
2. Name it (e.g. `flagswap-reader`), set **Role: Reader**, create, and copy it
   (shown once).

### (b) Validate it live from the CLI (no secret in code)

```
LD_TOKEN=api-xxxxxxxx npm run smoke:ld
# EU/US: LD_TOKEN=api-xxxx LD_BASE=https://app.eu.launchdarkly.com npm run smoke:ld
```

Prints project count, each env's client-side ID, the flag count + how many are
client-side/interceptable, and one normalized sample flag. (Run without
`LD_TOKEN` and it prints setup instructions and exits — no network.)

### (c) Test the sync in the loaded extension

1. Load the extension (steps above), click the toolbar icon.
2. Expand **LaunchDarkly connection**, paste the token, pick the region, click
   **Save**, then **Test connection** (shows project count or a clear error).
3. Under **Sync**, pick a **Project** and **Environment** — the **Client-side
   ID** auto-fills. Click **Sync flags**.
4. The flag list replaces the demo flags: booleans get an on/off control,
   multivariate flags get a variation-value dropdown (variation name shown if
   present), and server-side-only flags appear disabled with
   "server-side only — can't override".
5. Enable an override and pick a value — it persists to the same
   `flagswap:overrides` model the interceptor consumes. Synced flags are cached
   under `flagswap:flagCache:{proj}:{env}` for instant reopen (even offline);
   **Refresh** re-syncs.
6. To verify interception end-to-end, point the override at a flag your app reads
   and reload the app tab (use the env's client-side ID shown in the popup).

When no token is configured the popup falls back to the 4 demo flags, so the
extension still works offline and without a LaunchDarkly account.

---

## How to run the tests

### Unit tests (the real gate)

```
npm test
```

Runs `node --test test/core.test.js test/ldapi.test.js test/state.test.js`
(built-in test runner, no deps). Covers interception logic (against the **real**
`eval.json` + `patch.json` fixtures), the LD API shaping logic (`normalizeFlags`,
`normalizeProjects`, `parseNextLink`, `computeBackoffMs`, against the
hand-authored `projects.json` / `flags.json` / `flags-page2.json` fixtures), and
the storage-schema normalization + override resolution in `state.js`.

Current output:

```
1..67
# tests 67
# pass 67
# fail 0
```

### E2E (Playwright, best effort)

```
npm run e2e      # = xvfb-run -a node --test test/e2e.spec.mjs
```

Launches the built extension in a real (headed) Chromium under `xvfb`, seeds an
override, and asserts the demo page renders the overridden value instead of
LD's real one. See [ARCHITECTURE.md](ARCHITECTURE.md#e2e-test-internals) for
what it verifies and how.

> If E2E ever can't run (no `xvfb`, headless-only sandbox, extension load
> blocked), fall back to the **manual load-and-test steps** above. The unit
> tests remain the authoritative gate.

---

## Safety / how it works

**FlagSwap overrides are client-side and read-only. They can never change the
real server flag state, and they affect only your own browser.**

- **What an override actually does.** An override only rewrites the LaunchDarkly
  flag *evaluation response* as it arrives in *your* browser (poll/stream
  traffic, intercepted by the MAIN-world wrappers — see
  [ARCHITECTURE.md](ARCHITECTURE.md#interception-design)). Nothing is ever
  written back to LaunchDarkly, and no other user sees your changes. Reload the
  tab with FlagSwap disabled and you see LD's real values again.
- **Why it physically can't mutate server state.** *Reading* flag evaluations
  needs only a client-side ID (a public identifier embedded in the page).
  *Changing* a flag's real state requires a separate, privileged **write** call
  to the LD REST API authenticated with a secret API token that has writer/admin
  scope. FlagSwap never holds or uses such a token: the interception path uses no
  credentials at all, and the optional flag-list **sync** uses only a
  **Reader-scoped** token for read-only `GET`s (see
  [ARCHITECTURE.md](ARCHITECTURE.md#ld-api-token-security-model)). There is
  simply no code path in FlagSwap that issues a write to LaunchDarkly.
- **You always know when overrides are active.** Two local, unobtrusive
  indicators make this visible — both are display-only and never touch the page
  or LD:
  - **Toolbar badge.** When the current tab has N active overrides, the FlagSwap
    toolbar icon shows a small badge with the number N (blank when there are
    none). It is set per-tab from the content script's report and uses only the
    sender tab's id — FlagSwap does **not** request the broad `tabs` permission.
  - **On-page banner.** A small pill in the bottom-right corner of the page reads
    `FlagSwap · N override(s)` whenever N > 0. It is rendered inside a Shadow DOM
    host at the maximum z-index, so page CSS can't style it and it doesn't alter
    page layout; it disappears when there are no overrides. Hover it for a tooltip
    reiterating that the overrides are local and read-only.

  Both indicators are driven by the **same** `flagswap:overrides` event the
  interceptor consumes (`src/banner.js`, an ISOLATED-world content script →
  `chrome.runtime.sendMessage({type:'flagswap:count'})` → `src/background.js`
  sets the badge). The count is exactly the number of overrides effective for the
  page's host.

---

## Privacy

FlagSwap collects nothing and transmits nothing. All configuration — overrides,
groups, profiles, settings, and any LD API token you enter — is stored in
`chrome.storage.local` on your own machine. The only network request FlagSwap
originates is the optional flag-list sync, which goes directly to LaunchDarkly's
REST API with your own token. Full policy: [`docs/privacy.html`](docs/privacy.html)
(published at <https://raufb.github.io/FlagSwap/privacy.html>).

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR —
the unit suite is the authoritative gate, and E2E (`npm run e2e`) needs a headed
browser under `xvfb`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the internals:
file layout, interception design, known limitations, and where the
implementation deviates from its original design.

## License

[MIT](LICENSE) © Rauf Babayev
