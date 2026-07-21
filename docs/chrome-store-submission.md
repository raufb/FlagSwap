# Chrome Web Store submission — copy-paste fields

Internal submission worksheet — not user documentation.

FlagSwap v0.2.1 · package: `dist/packages/flagswap-0.2.1-chrome.zip`, produced by `npm run package` (`dist/` is generated and not checked in; the zip was verified in sync with `dist/chrome/manifest.json`).

---

## Privacy practices tab

### Single purpose description

FlagSwap lets QA engineers and developers override LaunchDarkly client-side feature flags in their own browser. It intercepts the LaunchDarkly SDK on any page where the user's app runs and substitutes the flag values the user has configured, so they can test features in on/off states without changing server-side flag configuration.

### `storage` — justification

Storage is used to persist the user's own configuration locally: their flag overrides, named flag groups, per-domain/subdomain profiles, and settings. It also caches the flags discovered on pages the user visits (flag key, type, and current value) so the UI can offer the correct control per flag without an API token. This data is required for the extension's core function — remembering which flags to override — and stays on the user's machine (chrome.storage). No storage data is transmitted to us.

### Host permission — justification

FlagSwap must run on whatever domain the user's application is served from. LaunchDarkly-powered apps run on arbitrary and changing hosts — localhost, staging subdomains, and production domains that differ per customer — so the content script matches all URLs to apply the user's flag overrides wherever their app runs. It only activates flag interception on pages that load the LaunchDarkly SDK; on all other pages it does nothing. The three LaunchDarkly host permissions (`https://app.launchdarkly.com/*`, plus `https://app.eu.launchdarkly.com/*` and `https://app.launchdarkly.us/*` for customers on LaunchDarkly's EU and US-federal instances — the user picks one region in the extension's options) are used solely for the optional flag-sync feature, which reads the user's own flag definitions from LaunchDarkly's REST API using an API token the user supplies.

### `sidePanel` — justification

The side panel is an optional, user-opened view of the same flag-override UI shown in the toolbar popup. It lets the user keep flag toggles visible alongside their app while testing, instead of the popup closing on every click. It shows only the extension's own interface and reads no page content.

### Remote code

Select **"No, I am not using remote code."** All scripts ship in the package; there is no `eval`, `new Function`, remote `<script src>`, or dynamic remote import.

If a reviewer questions the MAIN-world content script, use:

> The extension does not load or execute any remotely-hosted code. All scripts are bundled in the package. The content script runs in the page's main world to wrap the native XMLHttpRequest/fetch used by the LaunchDarkly SDK, using code included in the extension, so that configured flag overrides are returned to the page.

---

## Store listing tab

### Summary (132-char tagline)

Override LaunchDarkly feature flags in your browser. Toggle flags, save groups, switch per domain — for QA and developers.

### Description

**Override LaunchDarkly feature flags right in your browser — no server changes, no redeploys.**

FlagSwap is built for QA engineers and developers who need to test features in specific on/off states. It intercepts the LaunchDarkly client-side SDK on your app's pages and serves the flag values you choose, so you control what's enabled without touching flag configuration in LaunchDarkly.

**Features**
- Toggle individual feature flags on or off instantly
- Save named groups of flags and flip a whole set with one switch
- Per-domain and per-subdomain profiles — overrides follow you automatically as you move between localhost, staging, and production
- Optional sync: pull your real flag keys from the LaunchDarkly REST API using your own API token
- Side panel to keep flag controls open next to your app while testing

**Your data stays local.** All configuration and any API token you provide are stored in your browser. FlagSwap collects nothing, transmits nothing, and sells nothing.

---

## Data disclosures (must match the "stays local" claims above)

- Does this item collect user data? → the token + config are stored locally via chrome.storage and never sent to us. Answer per the form so it reflects **no collection/transmission to the developer**.
- Not sold to third parties.
- Not used for purposes unrelated to the single purpose.
- Not used for creditworthiness / lending.

---

## Actions only you can do

- [ ] Settings page → contact email: `rauf@babayev.com`
- [ ] Verify that email (Chrome sends a link — do this first, verification can lag)
- [ ] Tick the Developer Program Policy certification checkbox (Privacy practices tab)
- [ ] Privacy policy URL — likely required once data disclosures are filled. Host a short page; see draft below.
- [ ] Screenshots — at least one 1280×800 or 640×400 (none exist in the repo yet)

---

## Pre-submission checklist

- [x] Package in sync with built manifest (verified)
- [x] Listing description does NOT say "PoC" / "proof of concept" / "experimental"
- [x] 128×128 icon present
- [ ] Screenshots uploaded
- [ ] Privacy policy URL added
- [ ] Contact email set + verified
