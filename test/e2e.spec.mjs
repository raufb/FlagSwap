/*
 * FlagSwap end-to-end test (best effort).
 *
 * Launches a real Chromium with the unpacked extension loaded, seeds an
 * override into chrome.storage.local (via an extension page where chrome.* is
 * available), serves demo/index.html over http, opens it, and asserts the
 * rendered DOM shows the OVERRIDDEN value rather than LD's real value.
 *
 * MV3 caveats handled here:
 *   - MV3 content scripts / service workers do NOT run in the old headless mode
 *     or in chrome-headless-shell. We launch HEADED (headless:false) which works
 *     under xvfb-run on a display-less box.
 *   - We must use launchPersistentContext with --load-extension (not the normal
 *     headless launcher) for extensions to load at all.
 *
 * Run with:  xvfb-run -a node --test test/e2e.spec.mjs
 * (falls back to documented manual steps in README if it can't run here.)
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
const DEMO_DIR = path.join(ROOT, "demo");
// The loadable extension is the built Chrome target, not the repo root.
const EXT_DIR = path.join(ROOT, "dist", "chrome");

// Tiny static file server for the demo dir so the SDK runs from http(s) origin.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
      const file = path.join(DEMO_DIR, url);
      if (!file.startsWith(DEMO_DIR) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test("E2E: override is reflected in the rendered LD flags", async (t) => {
  // 12s of LD network + SDK init; give the whole test room.
  t.diagnostic("launching headed chromium with extension…");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flagswap-e2e-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // MV3 needs headed (run under xvfb-run on CI)
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        "--no-sandbox",
      ],
    });
  } catch (e) {
    assert.fail(
      "Could not launch Chromium with the extension: " +
        e.message +
        "\nSee README 'Manual E2E' for hand verification steps."
    );
    return;
  }

  const { server, port } = await startServer();
  const demoUrl = `http://127.0.0.1:${port}/index.html`;

  try {
    // Find the extension's service worker to learn its ID.
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10000 }).catch(
        () => null
      );
    }
    // The popup page is a reliable extension-origin page where chrome.storage
    // is available; navigate there to seed the override.
    // Derive extension id from the worker URL if present, else from any page.
    let extId = sw ? new URL(sw.url()).host : null;

    const seedPage = await context.newPage();
    if (!extId) {
      // Fallback: open the demo first so the extension activates, then check.
      await seedPage.goto(demoUrl);
      sw = context.serviceWorkers()[0];
      extId = sw ? new URL(sw.url()).host : null;
    }
    assert.ok(extId, "resolved extension id");

    await seedPage.goto(`chrome-extension://${extId}/src/popup.html`);
    // Seed: override flag-2 (string) "green" -> "red".
    await seedPage.evaluate(() => {
      return new Promise((resolve) => {
        chrome.storage.local.set(
          {
            "flagswap:overrides": {
              "client-side-flag-2-always-green": {
                value: "red",
                enabled: true,
              },
            },
          },
          resolve
        );
      });
    });
    t.diagnostic("override seeded; opening demo page");

    const page = await context.newPage();
    await page.goto(demoUrl, { waitUntil: "load" });

    // Wait for the SDK to render the overridden flag.
    const cell = page.locator(
      '[data-val="client-side-flag-2-always-green"]'
    );
    await cell.waitFor({ state: "visible", timeout: 20000 });
    // Poll for the overridden value (SDK may render real value briefly first,
    // though the gate should prevent that).
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-val="client-side-flag-2-always-green"]'
        );
        return el && el.textContent.includes("red");
      },
      { timeout: 20000 }
    );

    const text = await cell.textContent();
    assert.ok(
      text.includes("red"),
      `expected overridden value "red", got: ${text}`
    );
    assert.ok(!text.includes("green"), "real value 'green' should be gone");
  } finally {
    server.close();
    await context.close();
  }
});
