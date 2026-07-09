/*
 * Unit tests for src/state.js — pure migration + domain matching + resolver.
 * node:test + node:assert, no deps. Run via `npm test`.
 */
const test = require("node:test");
const assert = require("node:assert");

const S = require("../src/state.js");

// ---- migrate ------------------------------------------------------------

test("migrate: empty storage -> empty state", () => {
  assert.deepStrictEqual(S.migrate({}), {
    version: 1,
    globalOverrides: {},
    groups: [],
    domains: [],
    containers: [],
  });
  assert.deepStrictEqual(S.migrate(undefined), {
    version: 1,
    globalOverrides: {},
    groups: [],
    domains: [],
    containers: [],
  });
});

test("migrate: legacy flagswap:overrides wrapped as globalOverrides", () => {
  const legacy = { "flag-a": { value: true, enabled: true } };
  const out = S.migrate({ "flagswap:overrides": legacy });
  assert.strictEqual(out.version, 1);
  assert.deepStrictEqual(out.globalOverrides, legacy);
  assert.deepStrictEqual(out.groups, []);
  assert.deepStrictEqual(out.domains, []);
  assert.deepStrictEqual(out.containers, []);
});

test("migrate: new flagswap:state passes through, fills missing arrays/objects", () => {
  const state = {
    version: 1,
    globalOverrides: { x: { value: 1, enabled: true } },
    groups: [{ id: "g1", enabled: true, flags: {} }],
    domains: [{ enabled: true, matchType: "exact", pattern: "a.com" }],
    containers: [{ enabled: true, cookieStoreId: "firefox-container-1" }],
  };
  assert.deepStrictEqual(S.migrate({ "flagswap:state": state }), state);

  // missing pieces filled defensively
  const partial = S.migrate({ "flagswap:state": { version: 1 } });
  assert.deepStrictEqual(partial, {
    version: 1,
    globalOverrides: {},
    groups: [],
    domains: [],
    containers: [],
  });
});

test("migrate: new state takes precedence over legacy when both present", () => {
  const out = S.migrate({
    "flagswap:state": { version: 1, globalOverrides: { fromState: { value: 1, enabled: true } } },
    "flagswap:overrides": { fromLegacy: { value: 2, enabled: true } },
  });
  assert.ok(out.globalOverrides.fromState);
  assert.ok(!out.globalOverrides.fromLegacy, "legacy ignored when state exists");
});

// ---- matchesDomain ------------------------------------------------------

test("matchesDomain: exact", () => {
  const r = { matchType: "exact", pattern: "app.example.com" };
  assert.strictEqual(S.matchesDomain(r, "app.example.com"), true);
  assert.strictEqual(S.matchesDomain(r, "APP.EXAMPLE.COM"), true); // case-insensitive
  assert.strictEqual(S.matchesDomain(r, "x.app.example.com"), false);
  assert.strictEqual(S.matchesDomain(r, "example.com"), false);
});

test("matchesDomain: suffix matches domain + subdomains, not siblings", () => {
  const r = { matchType: "suffix", pattern: "example.com" };
  assert.strictEqual(S.matchesDomain(r, "example.com"), true); // the domain itself
  assert.strictEqual(S.matchesDomain(r, "app.example.com"), true); // subdomain
  assert.strictEqual(S.matchesDomain(r, "a.b.example.com"), true); // deep subdomain
  assert.strictEqual(S.matchesDomain(r, "notexample.com"), false); // sibling (no dot boundary)
  assert.strictEqual(S.matchesDomain(r, "example.com.evil.com"), false);
});

test("matchesDomain: glob with * wildcard, anchored full match", () => {
  assert.strictEqual(
    S.matchesDomain({ matchType: "glob", pattern: "*.example.com" }, "app.example.com"),
    true
  );
  assert.strictEqual(
    S.matchesDomain({ matchType: "glob", pattern: "*.example.com" }, "example.com"),
    false,
    "*.example.com requires a leading label"
  );
  assert.strictEqual(
    S.matchesDomain({ matchType: "glob", pattern: "app.*.com" }, "app.staging.com"),
    true
  );
  // regex metachars in the pattern are escaped (the dot is literal)
  assert.strictEqual(
    S.matchesDomain({ matchType: "glob", pattern: "a.com" }, "axcom"),
    false,
    "dot is literal, not 'any char'"
  );
});

test("matchesDomain: defensive on bad input", () => {
  assert.strictEqual(S.matchesDomain(null, "x.com"), false);
  assert.strictEqual(S.matchesDomain({ matchType: "exact" }, "x.com"), false); // no pattern
  assert.strictEqual(S.matchesDomain({ matchType: "weird", pattern: "x" }, "x"), false);
});

// ---- specificityScore ---------------------------------------------------

test("specificityScore: exact > suffix > glob; longer suffix beats shorter", () => {
  const exact = { matchType: "exact", pattern: "a.com" };
  const suffixLong = { matchType: "suffix", pattern: "app.example.com" };
  const suffixShort = { matchType: "suffix", pattern: "example.com" };
  const glob = { matchType: "glob", pattern: "*.com" };

  assert.ok(S.specificityScore(exact) > S.specificityScore(suffixLong));
  assert.ok(S.specificityScore(suffixLong) > S.specificityScore(suffixShort));
  assert.ok(S.specificityScore(suffixShort) > S.specificityScore(glob));
  // length tiebreak never crosses matchType bands
  assert.ok(
    S.specificityScore(exact) >
      S.specificityScore({ matchType: "suffix", pattern: "a".repeat(50) })
  );
});

// ---- resolveEffective ---------------------------------------------------

test("resolveEffective: global override only, disabled absent, every entry enabled:true", () => {
  const state = {
    version: 1,
    globalOverrides: {
      on: { value: "yes", enabled: true },
      off: { value: "no", enabled: false }, // disabled -> absent
    },
    groups: [],
    domains: [],
  };
  const out = S.resolveEffective(state, "any.com");
  assert.deepStrictEqual(out, { on: { value: "yes", enabled: true } });
});

test("resolveEffective: global enabled group only", () => {
  const state = {
    version: 1,
    globalOverrides: {},
    groups: [
      {
        id: "g1",
        enabled: true,
        flags: { a: { value: 1 }, b: { value: 2, variation: 3 } },
      },
      { id: "g2", enabled: false, flags: { c: { value: 9 } } }, // disabled group
    ],
    domains: [],
  };
  const out = S.resolveEffective(state, "x.com");
  assert.deepStrictEqual(out, {
    a: { value: 1, enabled: true },
    b: { value: 2, variation: 3, enabled: true },
  });
});

test("resolveEffective: individual global override beats group (applied after)", () => {
  const state = {
    version: 1,
    groups: [{ id: "g1", enabled: true, flags: { a: { value: "group" } } }],
    globalOverrides: { a: { value: "individual", enabled: true } },
    domains: [],
  };
  const out = S.resolveEffective(state, "x.com");
  assert.strictEqual(out.a.value, "individual");
});

test("resolveEffective: domain override beats global", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: { a: { value: "global", enabled: true } },
    domains: [
      {
        enabled: true,
        matchType: "exact",
        pattern: "app.example.com",
        groupIds: [],
        overrides: { a: { value: "domain", enabled: true } },
      },
    ],
  };
  assert.strictEqual(S.resolveEffective(state, "app.example.com").a.value, "domain");
  // non-matching host -> falls back to global
  assert.strictEqual(S.resolveEffective(state, "other.com").a.value, "global");
});

test("resolveEffective: more-specific domain beats less-specific (exact vs suffix)", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: {},
    domains: [
      {
        enabled: true,
        matchType: "suffix",
        pattern: "example.com",
        overrides: { a: { value: "suffix", enabled: true } },
      },
      {
        enabled: true,
        matchType: "exact",
        pattern: "app.example.com",
        overrides: { a: { value: "exact", enabled: true } },
      },
    ],
  };
  // exact is more specific -> applied last -> wins
  assert.strictEqual(S.resolveEffective(state, "app.example.com").a.value, "exact");
});

test("resolveEffective: longer suffix beats shorter suffix", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: {},
    domains: [
      {
        enabled: true,
        matchType: "suffix",
        pattern: "example.com",
        overrides: { a: { value: "short", enabled: true } },
      },
      {
        enabled: true,
        matchType: "suffix",
        pattern: "app.example.com",
        overrides: { a: { value: "long", enabled: true } },
      },
    ],
  };
  assert.strictEqual(S.resolveEffective(state, "app.example.com").a.value, "long");
});

test("resolveEffective: domain group via groupIds, unresolved ids ignored", () => {
  const state = {
    version: 1,
    groups: [{ id: "g1", enabled: true, flags: { a: { value: "fromGroup" } } }],
    globalOverrides: {},
    domains: [
      {
        enabled: true,
        matchType: "exact",
        pattern: "app.example.com",
        groupIds: ["g1", "does-not-exist"],
        overrides: {},
      },
    ],
  };
  const out = S.resolveEffective(state, "app.example.com");
  assert.strictEqual(out.a.value, "fromGroup");
});

test("resolveEffective: a globally-disabled group still applies when activated by a matching domain (domain-scoped group)", () => {
  const state = {
    version: 1,
    // group is globally OFF...
    groups: [{ id: "g1", enabled: false, flags: { a: { value: "scoped" } } }],
    globalOverrides: {},
    domains: [
      { enabled: true, matchType: "exact", pattern: "x.com", groupIds: ["g1"], overrides: {} },
    ],
  };
  // ...so it does NOT apply on a non-matching host (global step skips disabled group)
  assert.deepStrictEqual(S.resolveEffective(state, "other.com"), {});
  // ...but DOES apply on the domain that references it
  assert.strictEqual(S.resolveEffective(state, "x.com").a.value, "scoped");
});

test("resolveEffective: domain individual override beats domain group", () => {
  const state = {
    version: 1,
    groups: [{ id: "g1", enabled: true, flags: { a: { value: "group" } } }],
    globalOverrides: {},
    domains: [
      {
        enabled: true,
        matchType: "exact",
        pattern: "x.com",
        groupIds: ["g1"],
        overrides: { a: { value: "domainIndividual", enabled: true } },
      },
    ],
  };
  assert.strictEqual(S.resolveEffective(state, "x.com").a.value, "domainIndividual");
});

test("resolveEffective: multivariate variation carried through (group + override)", () => {
  const state = {
    version: 1,
    groups: [{ id: "g1", enabled: true, flags: { a: { value: "red", variation: 1 } } }],
    globalOverrides: { b: { value: "blue", variation: 2, enabled: true } },
    domains: [],
  };
  const out = S.resolveEffective(state, "x.com");
  assert.deepStrictEqual(out.a, { value: "red", variation: 1, enabled: true });
  assert.deepStrictEqual(out.b, { value: "blue", variation: 2, enabled: true });
});

test("resolveEffective: disabled domain does not contribute", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: {},
    domains: [
      {
        enabled: false,
        matchType: "exact",
        pattern: "x.com",
        overrides: { a: { value: "domain", enabled: true } },
      },
    ],
  };
  assert.deepStrictEqual(S.resolveEffective(state, "x.com"), {});
});

test("resolveEffective: disabled individual override absent even within matched domain", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: {},
    domains: [
      {
        enabled: true,
        matchType: "exact",
        pattern: "x.com",
        overrides: {
          a: { value: "on", enabled: true },
          b: { value: "off", enabled: false },
        },
      },
    ],
  };
  assert.deepStrictEqual(S.resolveEffective(state, "x.com"), {
    a: { value: "on", enabled: true },
  });
});

test("resolveEffective: full precedence chain (group < global < domain group < domain individual)", () => {
  const state = {
    version: 1,
    groups: [
      { id: "gGlobal", enabled: true, flags: { a: { value: "globalGroup" } } },
      { id: "gDomain", enabled: true, flags: { a: { value: "domainGroup" } } },
    ],
    globalOverrides: { a: { value: "globalIndividual", enabled: true } },
    domains: [
      {
        enabled: true,
        matchType: "exact",
        pattern: "x.com",
        groupIds: ["gDomain"],
        overrides: { a: { value: "domainIndividual", enabled: true } },
      },
    ],
  };
  assert.strictEqual(S.resolveEffective(state, "x.com").a.value, "domainIndividual");
});

test("resolveEffective: defensive on malformed state", () => {
  assert.deepStrictEqual(S.resolveEffective(null, "x.com"), {});
  assert.deepStrictEqual(S.resolveEffective({}, "x.com"), {});
  assert.deepStrictEqual(
    S.resolveEffective({ groups: "nope", domains: 5, globalOverrides: 7 }, "x.com"),
    {}
  );
});

// ---- container scope (Firefox contextual identities) --------------------

test("resolveEffective: no cookieStoreId -> container layer skipped (back-compat)", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: { a: { value: "global", enabled: true } },
    domains: [],
    containers: [
      {
        enabled: true,
        cookieStoreId: "firefox-container-1",
        mode: "merge",
        overrides: { a: { value: "container", enabled: true } },
      },
    ],
  };
  // 2-arg call (as domain-only callers use) never sees the container layer
  assert.strictEqual(S.resolveEffective(state, "x.com").a.value, "global");
  // empty cookieStoreId is likewise ignored
  assert.strictEqual(S.resolveEffective(state, "x.com", "").a.value, "global");
});

test("resolveEffective: merge container beats global + domain, only for its cookieStoreId", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: { a: { value: "global", enabled: true } },
    domains: [
      {
        enabled: true,
        matchType: "exact",
        pattern: "x.com",
        overrides: { a: { value: "domain", enabled: true } },
      },
    ],
    containers: [
      {
        enabled: true,
        cookieStoreId: "firefox-container-3",
        mode: "merge",
        overrides: { a: { value: "container", enabled: true } },
      },
    ],
  };
  // matching container -> wins over domain (highest precedence)
  assert.strictEqual(
    S.resolveEffective(state, "x.com", "firefox-container-3").a.value,
    "container"
  );
  // a DIFFERENT container -> no container layer -> domain wins
  assert.strictEqual(
    S.resolveEffective(state, "x.com", "firefox-container-9").a.value,
    "domain"
  );
});

test("resolveEffective: two containers, same host, opposite values (the core use case)", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: {},
    domains: [],
    containers: [
      {
        enabled: true,
        cookieStoreId: "firefox-container-1",
        mode: "merge",
        overrides: { feature: { value: true, enabled: true } },
      },
      {
        enabled: true,
        cookieStoreId: "firefox-container-2",
        mode: "merge",
        overrides: { feature: { value: false, enabled: true } },
      },
    ],
  };
  assert.strictEqual(
    S.resolveEffective(state, "app.example.com", "firefox-container-1").feature.value,
    true
  );
  assert.strictEqual(
    S.resolveEffective(state, "app.example.com", "firefox-container-2").feature.value,
    false
  );
});

test("resolveEffective: solo container isolates — lower layers dropped", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: {
      a: { value: "globalA", enabled: true },
      b: { value: "globalB", enabled: true },
    },
    domains: [],
    containers: [
      {
        enabled: true,
        cookieStoreId: "firefox-container-1",
        mode: "solo",
        overrides: { a: { value: "soloA", enabled: true } },
      },
    ],
  };
  const out = S.resolveEffective(state, "x.com", "firefox-container-1");
  // only the container's own flag survives; global 'b' is dropped (isolation)
  assert.deepStrictEqual(out, { a: { value: "soloA", enabled: true } });
});

test("resolveEffective: disabled container does not contribute", () => {
  const state = {
    version: 1,
    groups: [],
    globalOverrides: { a: { value: "global", enabled: true } },
    domains: [],
    containers: [
      {
        enabled: false,
        cookieStoreId: "firefox-container-1",
        mode: "merge",
        overrides: { a: { value: "container", enabled: true } },
      },
    ],
  };
  assert.strictEqual(
    S.resolveEffective(state, "x.com", "firefox-container-1").a.value,
    "global"
  );
});

test("resolveEffective: container activates a group via groupIds", () => {
  const state = {
    version: 1,
    groups: [{ id: "g1", enabled: false, flags: { a: { value: "fromGroup" } } }],
    globalOverrides: {},
    domains: [],
    containers: [
      {
        enabled: true,
        cookieStoreId: "firefox-container-1",
        mode: "merge",
        groupIds: ["g1"],
        overrides: {},
      },
    ],
  };
  // globally-off group activates only inside the container
  assert.deepStrictEqual(S.resolveEffective(state, "x.com"), {});
  assert.strictEqual(
    S.resolveEffective(state, "x.com", "firefox-container-1").a.value,
    "fromGroup"
  );
});

test("resolveEffective: container individual override beats its own group", () => {
  const state = {
    version: 1,
    groups: [{ id: "g1", enabled: true, flags: { a: { value: "group" } } }],
    globalOverrides: {},
    domains: [],
    containers: [
      {
        enabled: true,
        cookieStoreId: "firefox-container-1",
        mode: "merge",
        groupIds: ["g1"],
        overrides: { a: { value: "containerIndividual", enabled: true } },
      },
    ],
  };
  assert.strictEqual(
    S.resolveEffective(state, "x.com", "firefox-container-1").a.value,
    "containerIndividual"
  );
});
