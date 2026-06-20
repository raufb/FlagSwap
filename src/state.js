/*
 * FlagSwap state schema + resolver (UMD).
 *
 * The popup will (Phase 2) persist a RICH state — global overrides, named
 * groups, and per-domain profiles. The interceptor, however, only ever consumes
 * a FLAT map `{ [flagKey]: { value, variation?, enabled:true } }`. This module is
 * the pure bridge between the two: it migrates legacy/raw storage into the rich
 * schema and collapses that schema down to the flat map for a given hostname.
 *
 * Works in BOTH:
 *   - Node  (require('../src/state.js') -> module.exports)  ... used by unit tests
 *   - Browser (window.__FlagSwapState)                      ... used by bridge.js
 *
 * NO side effects, NO chrome.* access. Pure + defensive (tolerates missing fields).
 *
 * Rich state schema (version 1):
 *   {
 *     version: 1,
 *     globalOverrides: { [flagKey]: { value, variation?, enabled } },
 *     groups: [ { id, name?, enabled, flags: { [flagKey]: { value, variation? } } } ],
 *     domains: [ {
 *       enabled,
 *       matchType: 'exact'|'suffix'|'glob',
 *       pattern: <string>,
 *       groupIds: [<groupId>, ...],
 *       overrides: { [flagKey]: { value, variation?, enabled } }
 *     } ]
 *   }
 *
 * Flat output (what inject.js consumes via the CustomEvent):
 *   { [flagKey]: { value, variation?, enabled:true } }   // only enabled entries
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.__FlagSwapState = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STATE_KEY = "flagswap:state";
  var LEGACY_KEY = "flagswap:overrides";

  // ---- small defensive helpers -------------------------------------------
  function isObj(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }
  function asObj(v) {
    return isObj(v) ? v : {};
  }
  function asArr(v) {
    return Array.isArray(v) ? v : [];
  }

  /**
   * Normalize raw chrome.storage.local contents into the rich state schema.
   * @param {object} rawStorage  the storage bag (e.g. result of storage.local.get)
   * @returns {{version:1, globalOverrides:object, groups:Array, domains:Array}}
   */
  function migrate(rawStorage) {
    var raw = asObj(rawStorage);

    // 1) New schema present -> return it, defensively filling missing pieces.
    if (isObj(raw[STATE_KEY])) {
      var s = raw[STATE_KEY];
      return {
        version: 1,
        globalOverrides: asObj(s.globalOverrides),
        groups: asArr(s.groups),
        domains: asArr(s.domains),
      };
    }

    // 2) Legacy flat overrides present -> wrap as globalOverrides.
    if (isObj(raw[LEGACY_KEY])) {
      return {
        version: 1,
        globalOverrides: raw[LEGACY_KEY],
        groups: [],
        domains: [],
      };
    }

    // 3) Nothing -> empty state.
    return { version: 1, globalOverrides: {}, groups: [], domains: [] };
  }

  // ---- domain matching ----------------------------------------------------
  function escapeRegex(s) {
    // Escape every regex metachar EXCEPT '*', which we handle separately.
    return String(s).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Does a domain rule match the given hostname? Case-insensitive.
   * matchType:
   *   'exact'  -> hostname === pattern
   *   'suffix' -> hostname === pattern || hostname endsWith '.'+pattern
   *               (the domain itself AND all of its subdomains)
   *   'glob'   -> '*' wildcard, anchored full-match; other regex chars escaped
   * @param {object} rule  { matchType, pattern }
   * @param {string} hostname
   * @returns {boolean}
   */
  function matchesDomain(rule, hostname) {
    if (!isObj(rule)) return false;
    var host = String(hostname == null ? "" : hostname).toLowerCase();
    var pattern = String(rule.pattern == null ? "" : rule.pattern).toLowerCase();
    if (!pattern) return false;

    switch (rule.matchType) {
      case "exact":
        return host === pattern;
      case "suffix":
        return host === pattern || host.endsWith("." + pattern);
      case "glob":
        var re = new RegExp(
          "^" +
            pattern
              .split("*")
              .map(escapeRegex)
              .join(".*") +
            "$"
        );
        return re.test(host);
      default:
        return false;
    }
  }

  /**
   * Ordering score for domain rules (higher = more specific).
   * Base by matchType: exact=2, suffix=1, glob=0; tiebreak by pattern length so
   * a longer suffix (e.g. "app.example.com") outranks a shorter one
   * ("example.com"). The length term is scaled to never cross matchType bands.
   * @param {object} rule
   * @returns {number}
   */
  function specificityScore(rule) {
    if (!isObj(rule)) return 0;
    var base;
    switch (rule.matchType) {
      case "exact":
        base = 2;
        break;
      case "suffix":
        base = 1;
        break;
      default:
        base = 0; // glob (or unknown)
        break;
    }
    var len = String(rule.pattern == null ? "" : rule.pattern).length;
    // length tiebreak kept small relative to the base band (1.0) so it only
    // orders rules WITHIN the same matchType, never across bands.
    return base + len / 1000;
  }

  // ---- resolution ---------------------------------------------------------
  /**
   * Apply a flags map (group.flags or a *.flags-shaped object of
   * {value, variation?}) into the accumulator, marking enabled:true.
   * Used for group flags, which have no per-entry enabled flag (the GROUP's
   * enabled gates them).
   */
  function applyGroupFlags(acc, flagsMap) {
    var m = asObj(flagsMap);
    for (var key in m) {
      if (!Object.prototype.hasOwnProperty.call(m, key)) continue;
      var f = m[key];
      if (!isObj(f)) continue;
      var entry = { value: f.value, enabled: true };
      if (typeof f.variation === "number") entry.variation = f.variation;
      acc[key] = entry;
    }
  }

  /**
   * Apply an individual-override map (globalOverrides or domain.overrides) into
   * the accumulator. Only entries with enabled===true contribute.
   */
  function applyOverrides(acc, overridesMap) {
    var m = asObj(overridesMap);
    for (var key in m) {
      if (!Object.prototype.hasOwnProperty.call(m, key)) continue;
      var o = m[key];
      if (!isObj(o) || o.enabled !== true) continue;
      var entry = { value: o.value, enabled: true };
      if (typeof o.variation === "number") entry.variation = o.variation;
      acc[key] = entry;
    }
  }

  function findGroup(groups, id) {
    var arr = asArr(groups);
    for (var i = 0; i < arr.length; i++) {
      if (isObj(arr[i]) && arr[i].id === id) return arr[i];
    }
    return null;
  }

  /**
   * Collapse the rich state to the flat override map for a hostname.
   *
   * Precedence (LATER WINS via overwrite; only enabled entries contribute):
   *   1. global enabled groups, in array order (each group's flags)
   *   2. global individual globalOverrides (enabled:true only)
   *   3. enabled domains matching hostname, sorted ASCENDING by specificity so
   *      the MOST specific is applied LAST and wins; per matched domain:
   *        a. its groupIds (resolved against state.groups), in order — a domain
   *           reference activates the group regardless of the group's global
   *           `enabled` flag (so groups can be scoped to specific domains)
   *        b. its individual overrides (enabled:true only)
   *
   * @param {object} state     normalized state (run migrate() first)
   * @param {string} hostname
   * @returns {object} flat { [flagKey]: { value, variation?, enabled:true } }
   */
  function resolveEffective(state, hostname) {
    var s = isObj(state) ? state : { groups: [], domains: [], globalOverrides: {} };
    var acc = {};

    // (1) global enabled groups, in array order
    var groups = asArr(s.groups);
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (isObj(g) && g.enabled === true) {
        applyGroupFlags(acc, g.flags);
      }
    }

    // (2) global individual overrides
    applyOverrides(acc, s.globalOverrides);

    // (3) matching domains, most-specific applied last
    var host = String(hostname == null ? "" : hostname).toLowerCase();
    var matched = asArr(s.domains).filter(function (d) {
      return isObj(d) && d.enabled === true && matchesDomain(d, host);
    });
    matched.sort(function (a, b) {
      return specificityScore(a) - specificityScore(b); // ascending
    });

    for (var j = 0; j < matched.length; j++) {
      var dom = matched[j];
      // (3a) domain's groups via groupIds, in order
      var ids = asArr(dom.groupIds);
      for (var k = 0; k < ids.length; k++) {
        var grp = findGroup(groups, ids[k]);
        // A domain references a group by id; the reference IS the activation, so
        // the group applies on this domain regardless of its global `enabled`
        // flag (which only governs whether the group applies GLOBALLY in step 1).
        // This lets a group be scoped to specific domains (globally off, activated
        // per-domain). The group need only exist; unresolved ids are ignored.
        if (grp) {
          applyGroupFlags(acc, grp.flags);
        }
      }
      // (3b) domain's individual overrides
      applyOverrides(acc, dom.overrides);
    }

    return acc;
  }

  return {
    STATE_KEY: STATE_KEY,
    LEGACY_KEY: LEGACY_KEY,
    migrate: migrate,
    matchesDomain: matchesDomain,
    specificityScore: specificityScore,
    resolveEffective: resolveEffective,
  };
});
