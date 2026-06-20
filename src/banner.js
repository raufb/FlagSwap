/*
 * FlagSwap ISOLATED-world override indicator + badge reporter.
 *
 * Runs in the extension's default (ISOLATED) content-script world at
 * document_start (registered AFTER state.js/bridge.js so it shares the same
 * isolated world and the bridge has already wired its listeners). It is a pure
 * CONSUMER of the data flow — it never reads chrome.storage or touches the
 * interception path. It only:
 *
 *   1. listens (on window) for the SAME 'flagswap:overrides' CustomEvent the
 *      bridge dispatches, shaped { detail: { overrides: <flatMap> } }, and
 *      counts the active overrides for THIS page;
 *   2. (a) renders a small, unobtrusive bottom-right pill ("FlagSwap · N
 *      override(s)") inside a Shadow DOM host with a very high z-index, so page
 *      CSS can't bleed in and the page layout is untouched. The pill's tooltip
 *      makes explicit that overrides are LOCAL/READ-ONLY and never change server
 *      flag state. It updates on every event and is removed when count is 0;
 *   3. (b) reports the count to the service worker
 *      (chrome.runtime.sendMessage { type: 'flagswap:count', count }) so the SW
 *      can set the toolbar badge for this tab.
 *
 * TOP FRAME ONLY: the badge/banner describe the page the user sees, so we ignore
 * sub-frames (which also receive the event because the content script runs in
 * all_frames).
 */
(function () {
  "use strict";

  // Top frame only — sub-frames also get the event but must not draw a banner
  // or report a (duplicate / wrong) badge count for the tab.
  if (window.top !== window) return;

  var EVENT_NAME = "flagswap:overrides";
  var HOST_ID = "flagswap-indicator-host";

  // Tooltip text: be explicit that overrides are client-side only.
  var SAFETY_TOOLTIP =
    "FlagSwap is overriding LaunchDarkly flags for THIS browser only. " +
    "These overrides are local and read-only — they never change the real " +
    "server flag state or affect anyone else.";

  var hostEl = null; // the Shadow DOM host element (in the page DOM)
  var pillEl = null; // the pill element (inside the shadow root)

  // ---- on-page indicator (Shadow DOM) -------------------------------------

  function ensureIndicator() {
    if (hostEl && document.documentElement.contains(hostEl)) return;

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    // Neutralize any inherited page styling on the host itself; the real UI
    // lives in the shadow root, fully isolated from page CSS.
    hostEl.style.cssText = "all: initial;";

    var root = hostEl.attachShadow ? hostEl.attachShadow({ mode: "open" }) : null;

    pillEl = document.createElement("div");
    pillEl.setAttribute("part", "pill");
    pillEl.style.cssText = [
      "position: fixed",
      "right: 12px",
      "bottom: 12px",
      "z-index: 2147483647", // max 32-bit signed int — above any page layer
      "box-sizing: border-box",
      "max-width: 280px",
      "padding: 6px 10px",
      "border-radius: 999px",
      "background: #1f2933",
      "color: #ffffff",
      "font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "font-weight: 600",
      "letter-spacing: 0.2px",
      "box-shadow: 0 2px 8px rgba(0,0,0,0.35)",
      "border: 1px solid rgba(255,255,255,0.15)",
      "pointer-events: auto",
      "user-select: none",
      "cursor: default",
      "white-space: nowrap",
      "opacity: 0.92",
    ].join(";");

    if (root) {
      root.appendChild(pillEl);
    } else {
      // No Shadow DOM support (very old engine): fall back to appending the pill
      // directly. Inline styles still apply.
      hostEl.appendChild(pillEl);
    }

    // Append to <html>; at document_start <body> may not exist yet.
    (document.documentElement || document).appendChild(hostEl);
  }

  function removeIndicator() {
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
    }
    hostEl = null;
    pillEl = null;
  }

  function renderIndicator(count) {
    if (count > 0) {
      ensureIndicator();
      if (pillEl) {
        pillEl.textContent =
          "FlagSwap · " + count + " override" + (count === 1 ? "" : "s");
        pillEl.title = SAFETY_TOOLTIP;
      }
    } else {
      removeIndicator();
    }
  }

  // ---- badge reporting ----------------------------------------------------

  function reportCount(count) {
    try {
      // Fire-and-forget; provide a no-op callback so a missing receiver
      // (e.g. SW asleep / extension reloading) doesn't surface an unchecked
      // lastError warning.
      chrome.runtime.sendMessage({ type: "flagswap:count", count: count }, function () {
        // Touch lastError to swallow "receiving end does not exist" noise.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Extension context can be invalidated mid-navigation; ignore.
    }
  }

  // ---- event handling -----------------------------------------------------

  function onOverrides(ev) {
    var overrides = ev && ev.detail && ev.detail.overrides;
    var count =
      overrides && typeof overrides === "object" ? Object.keys(overrides).length : 0;
    renderIndicator(count);
    reportCount(count);
  }

  // The bridge dispatches on BOTH window and document; we listen on window
  // (matching the inject.js convention) so we hear it exactly once per push.
  window.addEventListener(EVENT_NAME, onOverrides);
})();
