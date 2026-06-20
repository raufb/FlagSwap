/*
 * FlagSwap core logic (UMD).
 *
 * Pure, side-effect-free functions for applying feature-flag overrides to
 * LaunchDarkly wire payloads. Works in BOTH:
 *   - Node  (require('../src/core.js')  -> module.exports)  ... used by unit tests
 *   - Browser (window.__FlagSwapCore)                       ... used by inject.js
 *
 * Keeping ALL business logic here makes it unit-testable without a browser.
 * inject.js / bridge.js are thin glue around these functions.
 */
(function (root, factory) {
  // UMD boilerplate.
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.__FlagSwapCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /*
   * BUMP strategy.
   *
   * LaunchDarkly's client SDK keeps the flag with the highest `version` and
   * discards incoming patches whose version is <= the one it already holds.
   * To make an override "sticky" against later real streaming patches, we set
   * the overridden flag's version to a very large constant. Real flag versions
   * for the demo env are single/double digits, so 2_000_000_000 (< 2^31) is far
   * above anything LD will legitimately send while staying a safe 32-bit int.
   *
   * We expose both the constant and a tiny strategy function so callers never
   * hardcode the number and so the bump is monotonic if applied repeatedly.
   */
  var BUMP = 2000000000;

  /**
   * Return a version guaranteed to win LD's `version > existing` check.
   * Always >= BUMP, and strictly greater than any plausible real version.
   * @param {number} [existingVersion]
   * @returns {number}
   */
  function bumpVersion(existingVersion) {
    var base = BUMP;
    if (typeof existingVersion === "number" && existingVersion >= base) {
      // Already bumped (e.g. re-applying overrides) -> keep climbing so a later
      // apply still wins. Keeps the operation idempotent-ish but monotonic.
      return existingVersion + 1;
    }
    return base;
  }

  /**
   * Is this override active and should it be applied?
   * Only entries explicitly { enabled: true } take effect.
   * @param {object} ov
   * @returns {boolean}
   */
  function isActiveOverride(ov) {
    return !!ov && ov.enabled === true;
  }

  /**
   * Produce the overridden version of a single flag wire object.
   * Returns a NEW object (does not mutate input). Preserves all unknown fields
   * (trackEvents, reason, flagVersion, ...) so the SDK sees a well-formed flag.
   *
   * @param {object} flagObj  existing wire object (may be undefined for a brand-new flag)
   * @param {object} ov       override { value, variation?, enabled }
   * @returns {object}
   */
  function overrideFlagObject(flagObj, ov) {
    var base = flagObj && typeof flagObj === "object" ? flagObj : {};
    var out = {};
    // shallow clone existing fields
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    out.value = ov.value;
    if (typeof ov.variation === "number") {
      out.variation = ov.variation;
    }
    out.version = bumpVersion(base.version);
    return out;
  }

  /**
   * Apply overrides to a full flags map (poll response body OR SSE `put` data).
   * The wire shape is a flat map { flagKey: flagObject }.
   *
   * For each ENABLED override:
   *   - if the flag already exists, rewrite value/variation and bump version.
   *   - if the flag does NOT exist, synthesize a minimal flag object so the SDK
   *     still surfaces the override (variation defaults to 0).
   * Non-overridden flags pass through untouched (same reference is fine; we
   * build a fresh map either way to avoid mutating the caller's object).
   *
   * @param {object} flagsMap
   * @param {object} overrides  { [flagKey]: { value, variation?, enabled } }
   * @returns {object} new map
   */
  function applyOverridesToMap(flagsMap, overrides) {
    var src = flagsMap && typeof flagsMap === "object" ? flagsMap : {};
    var ov = overrides && typeof overrides === "object" ? overrides : {};
    var out = {};

    // copy through existing flags
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
    }

    // apply each active override
    for (var ovKey in ov) {
      if (!Object.prototype.hasOwnProperty.call(ov, ovKey)) continue;
      var entry = ov[ovKey];
      if (!isActiveOverride(entry)) continue;
      out[ovKey] = overrideFlagObject(src[ovKey], entry);
    }
    return out;
  }

  /**
   * Apply overrides to a single SSE `patch` payload.
   * Patch wire shape: a flag object PLUS a top-level `key` field.
   *   { key, value, variation, version, flagVersion, ... }
   *
   * If the patch targets an ENABLED override:
   *   - rewrite value (and variation if specified) to the override
   *   - keep a high (bumped) version so this patch — and crucially, any real
   *     patch the SDK later receives at a normal version — cannot revert us.
   * Otherwise pass the patch through UNCHANGED (same reference).
   *
   * @param {object} patchObj
   * @param {object} overrides
   * @returns {object}
   */
  function applyOverrideToPatch(patchObj, overrides) {
    if (!patchObj || typeof patchObj !== "object") return patchObj;
    var ov = overrides && typeof overrides === "object" ? overrides : {};
    var key = patchObj.key;
    var entry = ov[key];
    if (!isActiveOverride(entry)) return patchObj; // pass-through

    var out = {};
    for (var k in patchObj) {
      if (Object.prototype.hasOwnProperty.call(patchObj, k)) out[k] = patchObj[k];
    }
    out.value = entry.value;
    if (typeof entry.variation === "number") {
      out.variation = entry.variation;
    }
    out.version = bumpVersion(patchObj.version);
    return out;
  }

  // ---- URL matchers -------------------------------------------------------
  // LD client-side endpoints (see CLAUDE.md ground truth):
  //   eval   : https://clientsdk.launchdarkly.com/sdk/evalx/<env>/contexts/<ctx>
  //            (also the older /sdk/eval/<env>/users/<ctx> form)
  //   stream : https://clientstream.launchdarkly.com/eval/<env>/<ctx>
  // We match structurally rather than on a fixed env id so the spike isn't
  // pinned to the demo environment.

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isLDEvalUrl(url) {
    if (typeof url !== "string") {
      // Request objects / URL objects -> coerce
      try {
        url = String(url && url.url ? url.url : url);
      } catch (e) {
        return false;
      }
    }
    return (
      /clientsdk\.launchdarkly\.com\/sdk\/eval/.test(url) ||
      // app.launchdarkly.com is sometimes used as the polling base
      /launchdarkly\.com\/sdk\/eval/.test(url)
    );
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  function isLDStreamUrl(url) {
    if (typeof url !== "string") {
      try {
        url = String(url && url.url ? url.url : url);
      } catch (e) {
        return false;
      }
    }
    return /clientstream\.launchdarkly\.com\/eval/.test(url) ||
      /stream\.launchdarkly\.com\/eval/.test(url);
  }

  return {
    BUMP: BUMP,
    bumpVersion: bumpVersion,
    isActiveOverride: isActiveOverride,
    overrideFlagObject: overrideFlagObject,
    applyOverridesToMap: applyOverridesToMap,
    applyOverrideToPatch: applyOverrideToPatch,
    isLDEvalUrl: isLDEvalUrl,
    isLDStreamUrl: isLDStreamUrl,
  };
});
