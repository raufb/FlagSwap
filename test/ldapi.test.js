/*
 * Unit tests for src/ldapi.js — pure LaunchDarkly API shaping logic.
 * node:test + node:assert, no deps. Runs against hand-authored fixtures built
 * from the verified LD API v2 shapes (LD-API-Version 20240415).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ld = require("../src/ldapi.js");

const FIXTURES = path.join(__dirname, "fixtures");
const projects = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "projects.json"), "utf8")
);
const flagsP1 = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "flags.json"), "utf8")
);
const flagsP2 = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "flags-page2.json"), "utf8")
);

// ---- normalizeProjects --------------------------------------------------

test("normalizeProjects: client-side ID equals env _id, secrets dropped", () => {
  const out = ld.normalizeProjects(projects.items);
  assert.strictEqual(out.length, 2);

  const def = out[0];
  assert.strictEqual(def.key, "default");
  assert.strictEqual(def.name, "Default Project");
  assert.strictEqual(def.environments.length, 2);

  const prod = def.environments[0];
  assert.strictEqual(prod.key, "production");
  assert.strictEqual(prod.name, "Production");
  // env._id IS the client-side ID
  assert.strictEqual(prod.clientSideId, "1111aaaa2222bbbb3333cccc");

  const testEnv = def.environments[1];
  assert.strictEqual(testEnv.clientSideId, "2222bbbb3333cccc4444dddd");

  // NEVER surface secrets
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("apiKey"), "apiKey must not leak");
  assert.ok(!serialized.includes("mobileKey"), "mobileKey must not leak");
  assert.ok(!serialized.includes("REDACTED"), "secret values must not leak");
});

test("normalizeProjects: tolerates missing/empty input", () => {
  assert.deepStrictEqual(ld.normalizeProjects(undefined), []);
  assert.deepStrictEqual(ld.normalizeProjects([]), []);
  const noEnvs = ld.normalizeProjects([{ key: "x", name: "X" }]);
  assert.deepStrictEqual(noEnvs[0].environments, []);
});

// ---- normalizeFlags -----------------------------------------------------

test("normalizeFlags: boolean flag normalized with on-state for env", () => {
  const out = ld.normalizeFlags(flagsP1.items, "test");
  const f = out.find((x) => x.key === "client-side-flag-1-always-true");
  assert.ok(f, "boolean flag present");
  assert.strictEqual(f.kind, "boolean");
  assert.strictEqual(f.clientSideAvailable, true);
  assert.strictEqual(f.on, true); // environments.test.on
  assert.strictEqual(f.variations.length, 2);
  assert.deepStrictEqual(
    f.variations.map((v) => v.value),
    [true, false]
  );
});

test("normalizeFlags: multivariate flag extracts variation values + names", () => {
  const out = ld.normalizeFlags(flagsP1.items, "production");
  const f = out.find((x) => x.key === "ui-theme");
  assert.ok(f);
  assert.strictEqual(f.kind, "multivariate");
  assert.strictEqual(f.clientSideAvailable, true);
  assert.strictEqual(f.on, false); // environments.production.on
  assert.deepStrictEqual(f.variations, [
    { value: "green", name: "Forest" },
    { value: "red", name: "Crimson" },
    { value: "blue", name: "Ocean" },
  ]);
});

test("normalizeFlags: server-side-only flag flagged not-client-side-available", () => {
  const out = ld.normalizeFlags(flagsP1.items, "production");
  const f = out.find((x) => x.key === "server-only-secret-rollout");
  assert.ok(f, "server-side flag is still returned (UI shows it disabled)");
  assert.strictEqual(f.clientSideAvailable, false);
});

test("normalizeFlags: legacy includeInSnippet counts as client-side available", () => {
  const out = ld.normalizeFlags(flagsP2.items, "production");
  const f = out.find((x) => x.key === "legacy-snippet-flag");
  assert.ok(f);
  assert.strictEqual(f.clientSideAvailable, true);
});

test("normalizeFlags: archived flags are dropped", () => {
  const out = ld.normalizeFlags(flagsP2.items, "production");
  assert.ok(
    !out.find((x) => x.key === "archived-old-flag"),
    "archived flag excluded"
  );
});

test("normalizeFlags: tolerates missing input", () => {
  assert.deepStrictEqual(ld.normalizeFlags(undefined, "x"), []);
  assert.deepStrictEqual(ld.normalizeFlags([], "x"), []);
});

test("normalizeFlags + pagination merge across two pages", () => {
  // Simulate the SW merging page1 + page2 items before normalizing.
  const merged = flagsP1.items.concat(flagsP2.items);
  const out = ld.normalizeFlags(merged, "production");
  // 3 from page1 + 1 client-side legacy from page2 (archived dropped) = 4
  const keys = out.map((f) => f.key).sort();
  assert.deepStrictEqual(keys, [
    "client-side-flag-1-always-true",
    "legacy-snippet-flag",
    "server-only-secret-rollout",
    "ui-theme",
  ]);
});

// ---- normalizeFlags: served value (LD default, not just `on`) -----------

// variations[0] = true, variations[1] = false (the usual boolean layout).
const boolVars = [
  { _id: "v-true", value: true },
  { _id: "v-false", value: false },
];
function boolFlag(envData) {
  return {
    key: "b",
    name: "B",
    kind: "boolean",
    variations: boolVars,
    clientSideAvailability: { usingEnvironmentId: true },
    environments: { production: envData },
  };
}

test("servedValue: on + full fallthrough variation maps to the served value", () => {
  // on=true but fallthrough serves variation 1 (false) -> default is FALSE,
  // even though targeting is on. This is the case the raw `on` bit gets wrong.
  const out = ld.normalizeFlags(
    [boolFlag({ on: true, fallthrough: { variation: 1 }, offVariation: 0 })],
    "production"
  );
  assert.strictEqual(out[0].on, true);
  assert.strictEqual(out[0].value, false);
});

test("servedValue: off serves offVariation, which can be TRUE", () => {
  // on=false but offVariation is variation 0 (true) -> default is TRUE.
  const out = ld.normalizeFlags(
    [boolFlag({ on: false, fallthrough: { variation: 0 }, offVariation: 0 })],
    "production"
  );
  assert.strictEqual(out[0].on, false);
  assert.strictEqual(out[0].value, true);
});

test("servedValue: falls back to summary=1 markers when full shape absent", () => {
  // summary representation: _summary.variations keyed by index, marked.
  const out = ld.normalizeFlags(
    [
      boolFlag({
        on: true,
        _summary: {
          variations: {
            0: { rules: 0, nullRules: 0, targets: 0, isOff: true },
            1: { rules: 0, nullRules: 0, targets: 0, isFallthrough: true },
          },
          prerequisites: 0,
        },
      }),
    ],
    "production"
  );
  assert.strictEqual(out[0].value, false); // fallthrough is variation 1 (false)
});

test("servedValue: percentage-rollout fallthrough is indeterminate (undefined)", () => {
  const out = ld.normalizeFlags(
    [boolFlag({ on: true, fallthrough: { rollout: { variations: [] } }, offVariation: 1 })],
    "production"
  );
  assert.strictEqual(out[0].value, undefined);
});

test("servedValue: rollout marked in summary is indeterminate (undefined)", () => {
  const out = ld.normalizeFlags(
    [
      boolFlag({
        on: true,
        _summary: {
          variations: {
            0: { rules: 0, nullRules: 0, targets: 0, isFallthrough: true, rollout: 60 },
            1: { rules: 0, nullRules: 0, targets: 0, isFallthrough: true, rollout: 40 },
          },
          prerequisites: 0,
        },
      }),
    ],
    "production"
  );
  assert.strictEqual(out[0].value, undefined);
});

test("servedValue: undefined when env carries only `on` (pre-summary fixtures)", () => {
  // Existing fixtures only have { on } — no served data, so value is omitted
  // and the UI falls back to `on`. Locks the graceful-degradation contract.
  const out = ld.normalizeFlags(flagsP1.items, "test");
  const f = out.find((x) => x.key === "client-side-flag-1-always-true");
  assert.strictEqual(f.value, undefined);
});

// ---- isClientSideAvailable ---------------------------------------------

test("isClientSideAvailable: modern, legacy, and negative cases", () => {
  assert.strictEqual(
    ld.isClientSideAvailable({
      clientSideAvailability: { usingEnvironmentId: true },
    }),
    true
  );
  assert.strictEqual(
    ld.isClientSideAvailable({
      clientSideAvailability: { usingEnvironmentId: false },
    }),
    false
  );
  assert.strictEqual(ld.isClientSideAvailable({ includeInSnippet: true }), true);
  assert.strictEqual(ld.isClientSideAvailable({ includeInSnippet: false }), false);
  assert.strictEqual(ld.isClientSideAvailable({}), false);
  assert.strictEqual(ld.isClientSideAvailable(null), false);
  // modern field wins over legacy when both present
  assert.strictEqual(
    ld.isClientSideAvailable({
      clientSideAvailability: { usingEnvironmentId: false },
      includeInSnippet: true,
    }),
    false
  );
});

// ---- parseNextLink ------------------------------------------------------

test("parseNextLink: returns next href when present, null otherwise", () => {
  assert.strictEqual(
    ld.parseNextLink(flagsP1),
    "/api/v2/flags/default?env=production&summary=1&limit=3&offset=3"
  );
  assert.strictEqual(ld.parseNextLink(flagsP2), null, "last page has no next");
  assert.strictEqual(ld.parseNextLink({}), null);
  assert.strictEqual(ld.parseNextLink({ _links: {} }), null);
  assert.strictEqual(ld.parseNextLink(null), null);
});

// ---- computeBackoffMs ---------------------------------------------------

test("computeBackoffMs: honors Retry-After seconds", () => {
  assert.strictEqual(
    ld.computeBackoffMs({ "Retry-After": "5" }, 0, 1000),
    5000
  );
  // case-insensitive header lookup
  assert.strictEqual(
    ld.computeBackoffMs({ "retry-after": "2" }, 0, 1000),
    2000
  );
});

test("computeBackoffMs: honors Retry-After HTTP-date", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const future = "Fri, 19 Jun 2026 00:00:10 GMT"; // +10s
  assert.strictEqual(ld.computeBackoffMs({ "Retry-After": future }, 0, now), 10000);
});

test("computeBackoffMs: uses X-Ratelimit-Reset epoch ms relative to now", () => {
  const now = 1_000_000;
  const reset = 1_000_000 + 3000;
  assert.strictEqual(
    ld.computeBackoffMs({ "X-Ratelimit-Reset": String(reset) }, 0, now),
    3000
  );
  // reset already passed -> 0
  assert.strictEqual(
    ld.computeBackoffMs({ "X-Ratelimit-Reset": String(now - 5) }, 0, now),
    0
  );
});

test("computeBackoffMs: exponential backoff deterministic without jitter", () => {
  // BASE=500, no jitter (rand omitted)
  assert.strictEqual(ld.computeBackoffMs({}, 0, 0), 500);
  assert.strictEqual(ld.computeBackoffMs({}, 1, 0), 1000);
  assert.strictEqual(ld.computeBackoffMs({}, 2, 0), 2000);
  assert.strictEqual(ld.computeBackoffMs({}, 3, 0), 4000);
});

test("computeBackoffMs: exponential backoff is capped", () => {
  // very high attempt -> capped at 30000
  assert.strictEqual(ld.computeBackoffMs({}, 20, 0), 30000);
});

test("computeBackoffMs: deterministic jitter via rand arg", () => {
  // attempt 0 -> 500 base + floor(0.5 * 500) = 500 + 250 = 750
  assert.strictEqual(ld.computeBackoffMs({}, 0, 0, 0.5), 750);
  assert.strictEqual(ld.computeBackoffMs({}, 0, 0, 0), 500);
});
