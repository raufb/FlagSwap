/*
 * FlagSwap ISOLATED-world bridge.
 *
 * Runs in the extension's default (ISOLATED) content-script world at
 * document_start. It is the ONLY side that can read chrome.storage. It:
 *   1. reads the rich state (flagswap:state) AND legacy overrides
 *      (flagswap:overrides) from chrome.storage.local,
 *   2. migrates + resolves them to the FLAT override map for THIS hostname via
 *      the pure resolver (window.__FlagSwapState),
 *   3. pushes that flat map into the MAIN world via CustomEvent
 *      ('flagswap:overrides') — the SAME event name/shape inject.js expects, so
 *      the interceptor never changes,
 *   4. re-resolves + re-pushes whenever EITHER key changes
 *      (chrome.storage.onChanged).
 *
 * It ALWAYS dispatches at least once (even with zero overrides) so the MAIN
 * world's "overrides ready" gate releases and the LD SDK is never blocked.
 *
 * MAIN-world inject.js cannot access chrome.* — hence this mandatory bridge.
 * state.js is loaded before this file in the ISOLATED content-script array so
 * window.__FlagSwapState is available here.
 */
(function () {
  "use strict";

  var EVENT_NAME = "flagswap:overrides";
  var SCHEMAS_EVENT = "flagswap:schemas";
  var DISCOVERED_KEY = "flagswap:discoveredFlags";
  var State = window.__FlagSwapState;

  // Keys the bridge cares about (state schema + legacy flat overrides).
  var STATE_KEY = State ? State.STATE_KEY : "flagswap:state";
  var LEGACY_KEY = State ? State.LEGACY_KEY : "flagswap:overrides";

  function hostname() {
    try {
      return String(location.hostname || "").toLowerCase();
    } catch (e) {
      return "";
    }
  }

  // Collapse raw storage -> flat override map for this hostname.
  function resolveFlat(rawStorage) {
    if (!State) {
      // Defensive: if state.js failed to load, fall back to legacy flat map so
      // the extension still works (and the readiness gate still releases).
      var legacy = rawStorage && rawStorage[LEGACY_KEY];
      return legacy && typeof legacy === "object" ? legacy : {};
    }
    var state = State.migrate(rawStorage);
    return State.resolveEffective(state, hostname());
  }

  function push(overrides) {
    var detail = { overrides: overrides || {} };
    // Firefox: objects created in the content-script (ISOLATED) compartment are
    // NOT readable by MAIN-world (page) code — reading ev.detail.overrides in
    // inject.js throws "Permission denied to access property". cloneInto exposes
    // a copy in the page compartment so the page can read it. Chrome has no
    // cloneInto and needs none (its MAIN/ISOLATED CustomEvent passing works).
    if (typeof cloneInto === "function") {
      try {
        detail = cloneInto(detail, window);
      } catch (e) {}
    }
    // Dispatch on both window and document so the MAIN listener (on window)
    // always hears it regardless of timing/target conventions.
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: detail }));
    } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: detail }));
    } catch (e) {}
  }

  // Initial read — always push, even if empty, to release the readiness gate.
  try {
    chrome.storage.local.get([STATE_KEY, LEGACY_KEY], function (res) {
      push(resolveFlat(res || {}));
    });
  } catch (e) {
    // If storage is unavailable for any reason, still release the gate.
    push({});
  }

  // Receive flag schemas discovered by inject.js from intercepted LD eval
  // responses and persist them so the popup can show typed value controls
  // (toggle for booleans, number input, etc.) without needing an API token.
  try {
    window.addEventListener(SCHEMAS_EVENT, function (ev) {
      try {
        var rawSchemas;
        try { rawSchemas = ev && ev.detail && ev.detail.schemas; } catch (e) { return; }
        if (!rawSchemas || typeof rawSchemas !== "object") return;
        // JSON round-trip handles Firefox cross-compartment object wrappers.
        var schemas;
        try { schemas = JSON.parse(JSON.stringify(rawSchemas)); } catch (e) { return; }
        chrome.storage.local.get([DISCOVERED_KEY], function (res) {
          var existing = (res && res[DISCOVERED_KEY]) || {};
          var changed = false;
          for (var key in schemas) {
            if (!Object.prototype.hasOwnProperty.call(schemas, key)) continue;
            var incoming = schemas[key];
            var existingEntry = existing[key];
            var kindChanged = !existingEntry || existingEntry.kind !== incoming.kind;
            var valueChanged = incoming.value !== undefined &&
                               (!existingEntry || existingEntry.value !== incoming.value);
            if (kindChanged || valueChanged) {
              var newEntry = { kind: incoming.kind };
              if (incoming.value !== undefined) newEntry.value = incoming.value;
              existing[key] = newEntry;
              changed = true;
            }
          }
          if (!changed) return;
          var write = {};
          write[DISCOVERED_KEY] = existing;
          chrome.storage.local.set(write);
        });
      } catch (e) {}
    });
  } catch (e) {}

  // Live updates: re-resolve + re-push whenever EITHER key changes.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (!changes[STATE_KEY] && !changes[LEGACY_KEY]) return;
      // Re-read both keys (a change event only carries the changed key) so the
      // resolver always sees the full current picture.
      chrome.storage.local.get([STATE_KEY, LEGACY_KEY], function (res) {
        push(resolveFlat(res || {}));
      });
    });
  } catch (e) {}
})();
