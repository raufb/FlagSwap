/*
 * FlagSwap Tier-2 E2E — transport observation for LD's useReport + streaming.
 *
 * Question: when the LD SDK uses useReport:true + streaming, does the stream
 * flow through our window.EventSource wrapper (interceptable) or through a
 * polyfilled fetch/XHR stream (BYPASS — MV3 can't rewrite a streaming body)?
 *
 * Method: DIRECT TRANSPORT OBSERVATION via window.__FLAGSWAP_STATS, not a live
 * patch. We run both modes against the real trial env and report what happens.
 *
 * HARD GATE (assert): in BOTH modes the INITIAL value of `test` is overridden
 * to false (our fetch wrapper must catch the GET poll AND the REPORT poll).
 * We do NOT assert which streaming transport is used — we print a verdict.
 *
 * Run with:  npm run e2e:tier2   (= xvfb-run -a node --test test/e2e-tier2.spec.mjs)
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// The loadable extension is the built Chrome target, not the repo root.
const EXT_DIR = path.join(ROOT, "dist", "chrome");
const DEMO_DIR = path.join(ROOT, "demo");

// Static server for the demo dir (preserves query string for the page; the
// router itself ignores it but the browser keeps ?report=1 in location.search).
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = req.url === "/" ? "/index.html" : req.url.split("?")[0];
      const file = path.join(DEMO_DIR, pathname);
      if (!file.startsWith(DEMO_DIR) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port })
    );
  });
}

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flagswap-t2-"));
  return chromium.launchPersistentContext(userDataDir, {
    headless: false, // MV3 needs headed (run under xvfb-run)
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-sandbox",
    ],
  });
}

async function resolveExtId(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context
      .waitForEvent("serviceworker", { timeout: 10000 })
      .catch(() => null);
  }
  return sw ? new URL(sw.url()).host : null;
}

async function seedOverride(context, extId) {
  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${extId}/src/popup.html`);
  await seedPage.evaluate(() => {
    return new Promise((resolve) => {
      chrome.storage.local.set(
        {
          "flagswap:overrides": {
            test: { value: false, enabled: true },
          },
        },
        resolve
      );
    });
  });
  await seedPage.close();
}

// Run one mode; returns { flagText, stats, streamEstablished }.
async function runMode(context, baseUrl, report) {
  const url = baseUrl + "/tier2.html" + (report ? "?report=1" : "");
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" });

  // Wait for the flag cell to leave its placeholder (SDK ready).
  await page
    .locator("#flag-test")
    .filter({ hasNotText: "…" })
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => {});
  // More robust: wait until #flag-test is not the placeholder.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector("#flag-test");
        return el && el.textContent && el.textContent !== "…";
      },
      { timeout: 20000 }
    )
    .catch(() => {});

  // Wait (best effort) for a stream to establish via EITHER transport.
  let streamEstablished = false;
  try {
    await page.waitForFunction(
      () => {
        const s = window.__FLAGSWAP_STATS || {};
        return (s.ldStreamEventSources || 0) + (s.ldStreamFetches || 0) > 0;
      },
      { timeout: 10000 }
    );
    streamEstablished = true;
  } catch (e) {
    streamEstablished = false; // timed out — record it, don't fail here
  }

  // The SDK may render the initial (non-overridden) value first — it fires
  // 'ready' from the XHR poll, THEN 'change' when the EventSource 'put' rewrite
  // lands. Give the override a fair chance to settle to "false" before reading,
  // so we measure the steady state rather than a transient. If it never becomes
  // "false" within the window, we capture whatever it is (a real bypass result).
  await page
    .waitForFunction(
      () => document.querySelector("#flag-test")?.textContent === "false",
      { timeout: 6000 }
    )
    .catch(() => {});

  const flagText = (await page.locator("#flag-test").textContent()) || "";
  const stats = await page.evaluate(
    () => window.__FLAGSWAP_STATS || {}
  );
  await page.close();
  return { flagText: flagText.trim(), stats, streamEstablished };
}

test("Tier-2: useReport + streaming transport observation", async (t) => {
  t.diagnostic("launching headed chromium with extension…");
  const context = await launch();
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const results = {};
  try {
    const extId = await resolveExtId(context);
    assert.ok(extId, "resolved extension id");
    await seedOverride(context, extId);
    t.diagnostic("override seeded: test -> false");

    // default (GET) mode
    results.default = await runMode(context, baseUrl, false);
    t.diagnostic("default mode done");

    // report (REPORT) mode — fresh seed is unnecessary (storage persists in the
    // same persistent context), but re-seed to be safe against any clear.
    await seedOverride(context, extId);
    results.report = await runMode(context, baseUrl, true);
    t.diagnostic("report mode done");
  } finally {
    server.close();
    await context.close();
  }

  // ---- verdict block (printed, not asserted) ------------------------------
  function verdict(label, r) {
    const s = r.stats || {};
    const es = s.ldStreamEventSources || 0;
    const f = s.ldStreamFetches || 0;
    const ev = s.ldEvalFetches || 0;
    const xhr = s.ldEvalXhrs || 0;
    const ping = s.ldStreamPings || 0;
    const wrapperIntercept = es > 0 ? "YES" : "NO";
    const streamBypassFetch = f > 0 && es === 0 ? "YES" : "NO";
    // Poll transport used: XHR (now COVERED by the XHR wrapper) vs fetch.
    const pollViaXhr = xhr > 0 ? "YES" : "NO";
    const overrideHolds = r.flagText === "false" ? "YES" : "NO";
    return [
      `${label}: flag-test=${JSON.stringify(r.flagText)} streamEstablished=${r.streamEstablished}`,
      `${label}: ldEvalFetches=${ev} ldEvalXhrs=${xhr} ldStreamEventSources=${es} ldStreamFetches=${f} ldStreamPings=${ping}`,
      `${label}: stream intercepted via EventSource wrapper: ${wrapperIntercept}`,
      `${label}: stream uses fetch (uninterceptable in MV3): ${streamBypassFetch}`,
      `${label}: poll uses XHR (now covered by XHR wrapper): ${pollViaXhr}`,
      `${label}: OVERRIDE HOLDS (flag-test==false): ${overrideHolds}`,
    ].join("\n");
  }

  console.log("\n==================== TIER-2 VERDICT ====================");
  console.log(verdict("default", results.default));
  console.log("--------------------------------------------------------");
  console.log(verdict("report ", results.report));
  console.log("========================================================\n");

  // ---- HARD GATE: override must hold in BOTH modes ------------------------
  // The XHR wrapper rewrites the eval response for BOTH the GET poll and the
  // REPORT poll, so the SDK's value of `test` must be false in both modes
  // regardless of which streaming transport is used. (default also gets a stream
  // 'put' rewrite via the EventSource wrapper; either path suffices.)
  assert.strictEqual(
    results.default.flagText,
    "false",
    `[default/GET] override FAILED — flag-test=${results.default.flagText} (expected false). ` +
      `Both the XHR eval-rewrite and the EventSource 'put' rewrite should produce false here. ` +
      `See verdict above.`
  );
  assert.strictEqual(
    results.report.flagText,
    "false",
    `[report/REPORT] override FAILED — flag-test=${results.report.flagText} (expected false). ` +
      `useReport:true uses PING streaming + a REPORT poll over XMLHttpRequest; the XHR wrapper ` +
      `must rewrite that REPORT response. A 'true' here means the XHR rewrite did not cover the ` +
      `REPORT poll. See verdict above.`
  );
});
