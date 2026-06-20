/*
 * FlagSwap LaunchDarkly API logic (UMD).
 *
 * Pure, side-effect-free helpers for shaping LaunchDarkly REST API v2 payloads
 * into the minimal data the override UI needs. Works in BOTH:
 *   - Node  (require('../src/ldapi.js') -> module.exports)  ... used by unit tests
 *   - Browser (window.__FlagSwapLdApi)                      ... used by popup/SW
 *
 * NO network, NO token handling here — that lives in the service worker. Keeping
 * this pure makes it unit-testable without a browser or a live token.
 *
 * Verified API shapes (LD-API-Version 20240415):
 *   GET /projects?expand=environments
 *     -> { items:[{ key, name, environments:{ items:[{ _id, key, name, ... }] } }] }
 *        (env._id IS the client-side ID)
 *   GET /flags/{projectKey}?env={envKey}&summary=1
 *     -> { items:[{ key, name, kind, variations:[{_id,value,name?,description?}],
 *                   clientSideAvailability:{usingEnvironmentId,usingMobileKey},
 *                   includeInSnippet?, tags, archived,
 *                   environments:{ [envKey]:{ on } } }],
 *          totalCount, _links:{ next?:{ href } } }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.__FlagSwapLdApi = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Is a flag exposed to client-side (environment-ID) SDKs, i.e. interceptable?
   * Modern field: clientSideAvailability.usingEnvironmentId.
   * Legacy fallback: includeInSnippet (older flags / older API responses).
   * @param {object} flag raw flag item
   * @returns {boolean}
   */
  function isClientSideAvailable(flag) {
    if (!flag || typeof flag !== "object") return false;
    var csa = flag.clientSideAvailability;
    if (csa && typeof csa === "object") {
      return csa.usingEnvironmentId === true;
    }
    // Legacy flags predate clientSideAvailability and use includeInSnippet.
    return flag.includeInSnippet === true;
  }

  /**
   * Extract the variation list as { value, name } pairs (name optional).
   * @param {object} flag
   * @returns {Array<{value:*, name?:string}>}
   */
  function extractVariations(flag) {
    var vars = flag && Array.isArray(flag.variations) ? flag.variations : [];
    return vars.map(function (v) {
      var out = { value: v ? v.value : undefined };
      if (v && typeof v.name === "string" && v.name.length) out.name = v.name;
      return out;
    });
  }

  /**
   * Read the per-environment `on` state for the given env, if present.
   * @param {object} flag
   * @param {string} envKey
   * @returns {boolean|undefined}
   */
  function envOnState(flag, envKey) {
    if (!flag || typeof flag.environments !== "object" || !flag.environments) {
      return undefined;
    }
    var e = flag.environments[envKey];
    if (e && typeof e.on === "boolean") return e.on;
    return undefined;
  }

  /**
   * Normalize raw flag items into the minimal UI shape.
   * Archived flags are dropped (not useful for live overrides).
   * @param {Array<object>} rawItems
   * @param {string} envKey
   * @returns {Array<{key,name,kind,variations,clientSideAvailable,on}>}
   */
  function normalizeFlags(rawItems, envKey) {
    var items = Array.isArray(rawItems) ? rawItems : [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var f = items[i];
      if (!f || typeof f !== "object") continue;
      if (f.archived === true) continue;
      out.push({
        key: f.key,
        name: typeof f.name === "string" ? f.name : f.key,
        kind: f.kind === "multivariate" ? "multivariate" : "boolean",
        variations: extractVariations(f),
        clientSideAvailable: isClientSideAvailable(f),
        on: envOnState(f, envKey),
      });
    }
    return out;
  }

  /**
   * Normalize raw project items, surfacing each env's client-side ID (env._id).
   * Never surfaces apiKey/mobileKey (secrets).
   * @param {Array<object>} rawItems
   * @returns {Array<{key,name,environments:Array<{clientSideId,key,name}>}>}
   */
  function normalizeProjects(rawItems) {
    var items = Array.isArray(rawItems) ? rawItems : [];
    return items.map(function (p) {
      var envItems =
        p && p.environments && Array.isArray(p.environments.items)
          ? p.environments.items
          : [];
      return {
        key: p ? p.key : undefined,
        name: p && typeof p.name === "string" ? p.name : p ? p.key : undefined,
        environments: envItems.map(function (e) {
          return {
            // env._id is the client-side ID used by the JS SDK / our interceptor.
            clientSideId: e ? e._id : undefined,
            key: e ? e.key : undefined,
            name: e && typeof e.name === "string" ? e.name : e ? e.key : undefined,
          };
        }),
      };
    });
  }

  /**
   * Extract the pagination "next" href, or null if there is no next page.
   * LD returns it under body._links.next.href as a RELATIVE path under the host.
   * @param {object} body
   * @returns {string|null}
   */
  function parseNextLink(body) {
    if (!body || typeof body !== "object") return null;
    var links = body._links;
    if (!links || typeof links !== "object") return null;
    var next = links.next;
    if (next && typeof next.href === "string" && next.href.length) {
      return next.href;
    }
    return null;
  }

  /**
   * Compute how long to wait before a retry, in milliseconds. PURE.
   *
   * Priority:
   *   1. Retry-After header (seconds, or an HTTP-date) — honored on 429.
   *   2. X-Ratelimit-Reset (epoch MS) — wait until reset relative to `now`.
   *   3. Exponential backoff: base * 2^attempt, capped, plus optional jitter.
   *
   * Jitter is injected via the `rand` arg (default 0 -> deterministic) so tests
   * can assert exact values. `attempt` is 0-based.
   *
   * @param {object} headers   case-insensitive-ish header map (we check a few cases)
   * @param {number} attempt   0-based retry attempt
   * @param {number} now       current epoch ms (for X-Ratelimit-Reset math)
   * @param {number} [rand]    0..1 jitter source (default 0)
   * @returns {number} ms to wait (>= 0)
   */
  function computeBackoffMs(headers, attempt, now, rand) {
    var h = headers || {};
    function get(name) {
      // tolerate exact, lower, and Title-Case header keys
      if (h[name] != null) return h[name];
      var lower = name.toLowerCase();
      if (h[lower] != null) return h[lower];
      var upper = name.toUpperCase();
      if (h[upper] != null) return h[upper];
      return undefined;
    }

    // 1) Retry-After (seconds or HTTP-date)
    var ra = get("Retry-After");
    if (ra != null) {
      var raNum = Number(ra);
      if (!isNaN(raNum) && isFinite(raNum)) {
        return Math.max(0, Math.round(raNum * 1000));
      }
      var raDate = Date.parse(ra);
      if (!isNaN(raDate)) {
        return Math.max(0, raDate - (now || 0));
      }
    }

    // 2) X-Ratelimit-Reset (epoch ms)
    var reset = get("X-Ratelimit-Reset");
    if (reset != null) {
      var resetNum = Number(reset);
      if (!isNaN(resetNum) && isFinite(resetNum) && resetNum > 0) {
        var wait = resetNum - (now || 0);
        if (wait > 0) return Math.round(wait);
        // reset already passed -> minimal wait
        return 0;
      }
    }

    // 3) Exponential backoff with cap + optional jitter.
    var BASE = 500; // ms
    var CAP = 30000; // 30s ceiling
    var a = typeof attempt === "number" && attempt >= 0 ? attempt : 0;
    var exp = Math.min(CAP, BASE * Math.pow(2, a));
    var jitter = typeof rand === "number" ? Math.floor(rand * BASE) : 0;
    return exp + jitter;
  }

  return {
    isClientSideAvailable: isClientSideAvailable,
    extractVariations: extractVariations,
    normalizeFlags: normalizeFlags,
    normalizeProjects: normalizeProjects,
    parseNextLink: parseNextLink,
    computeBackoffMs: computeBackoffMs,
  };
});
