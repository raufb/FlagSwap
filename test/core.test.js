/*
 * Unit tests for src/core.js — the pure interception logic.
 * Uses node:test + node:assert (no external deps). Run with `npm test`.
 *
 * Tests run against the REAL captured fixture (test/fixtures/eval.json) and a
 * hand-authored patch fixture (test/fixtures/patch.json) so we're validating
 * against LaunchDarkly's actual wire shape, not an invented one.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const core = require("../src/core.js");

const FIXTURES = path.join(__dirname, "fixtures");
const evalFixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "eval.json"), "utf8")
);
const patchFixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "patch.json"), "utf8")
);

const F1 = "client-side-flag-1-always-true";
const F2 = "client-side-flag-2-always-green";
const F3 = "client-side-flag-3-does-name-start-with-b";

test("fixture sanity: eval.json has the 4 demo flags with expected values", () => {
  assert.strictEqual(evalFixture[F1].value, true);
  assert.strictEqual(evalFixture[F2].value, "green");
  assert.ok(Object.keys(evalFixture).length >= 4);
});

test("applyOverridesToMap: boolean flag flips value AND bumps version above original", () => {
  const original = evalFixture[F1];
  const overrides = { [F1]: { value: false, variation: 1, enabled: true } };
  const out = core.applyOverridesToMap(evalFixture, overrides);

  assert.strictEqual(out[F1].value, false, "value flipped to false");
  assert.strictEqual(out[F1].variation, 1, "variation applied");
  assert.ok(
    out[F1].version > original.version,
    `version bumped (${out[F1].version} > ${original.version})`
  );
  assert.ok(out[F1].version >= core.BUMP, "version >= BUMP");
  // preserves unrelated wire fields
  assert.strictEqual(out[F1].flagVersion, original.flagVersion);
});

test("applyOverridesToMap: does not mutate the input map", () => {
  const before = JSON.stringify(evalFixture);
  core.applyOverridesToMap(evalFixture, {
    [F1]: { value: false, enabled: true },
  });
  assert.strictEqual(JSON.stringify(evalFixture), before, "input untouched");
});

test("applyOverridesToMap: string flag override 'green' -> 'red' works", () => {
  const overrides = { [F2]: { value: "red", enabled: true } };
  const out = core.applyOverridesToMap(evalFixture, overrides);
  assert.strictEqual(out[F2].value, "red");
  assert.ok(out[F2].version >= core.BUMP);
});

test("applyOverridesToMap: non-overridden flag passes through unchanged", () => {
  const overrides = { [F1]: { value: false, enabled: true } };
  const out = core.applyOverridesToMap(evalFixture, overrides);
  // F3 was not overridden -> identical to fixture
  assert.deepStrictEqual(out[F3], evalFixture[F3]);
});

test("applyOverridesToMap: disabled override does NOT apply", () => {
  const overrides = { [F1]: { value: false, enabled: false } };
  const out = core.applyOverridesToMap(evalFixture, overrides);
  assert.strictEqual(out[F1].value, true, "still original true");
  assert.strictEqual(out[F1].version, evalFixture[F1].version, "version untouched");
});

test("applyOverridesToMap: override for a brand-new (unseen) flag is synthesized", () => {
  const overrides = { "new-flag": { value: "hello", enabled: true } };
  const out = core.applyOverridesToMap(evalFixture, overrides);
  assert.strictEqual(out["new-flag"].value, "hello");
  assert.ok(out["new-flag"].version >= core.BUMP);
});

test("applyOverrideToPatch: rewrites a patch targeting an overridden flag", () => {
  // patchFixture targets F1 with value true, version 2.
  const overrides = { [F1]: { value: false, variation: 1, enabled: true } };
  const out = core.applyOverrideToPatch(patchFixture, overrides);

  assert.strictEqual(out.key, F1, "key preserved");
  assert.strictEqual(out.value, false, "value rewritten to override");
  assert.strictEqual(out.variation, 1, "variation rewritten");
  assert.ok(
    out.version >= core.BUMP && out.version > patchFixture.version,
    "version kept high so real patch cannot revert override"
  );
});

test("applyOverrideToPatch: passes through a patch for a non-overridden flag", () => {
  const overrides = { [F2]: { value: "red", enabled: true } };
  const out = core.applyOverrideToPatch(patchFixture, overrides);
  // patch targets F1, which is not overridden here -> identical reference/content
  assert.strictEqual(out, patchFixture, "same reference (pure pass-through)");
});

test("applyOverrideToPatch: disabled override -> pass-through", () => {
  const overrides = { [F1]: { value: false, enabled: false } };
  const out = core.applyOverrideToPatch(patchFixture, overrides);
  assert.strictEqual(out, patchFixture);
});

test("bumpVersion: monotonic when already bumped", () => {
  const once = core.bumpVersion(5);
  assert.strictEqual(once, core.BUMP);
  const twice = core.bumpVersion(core.BUMP);
  assert.ok(twice > core.BUMP, "re-bump climbs");
});

test("isLDEvalUrl: matches real eval URL, rejects unrelated", () => {
  const real =
    "https://clientsdk.launchdarkly.com/sdk/evalx/5cc8a87be4b564081fd2fd70/contexts/abc";
  assert.strictEqual(core.isLDEvalUrl(real), true);
  assert.strictEqual(core.isLDEvalUrl("https://example.com/api/flags"), false);
  assert.strictEqual(
    core.isLDEvalUrl("https://clientstream.launchdarkly.com/eval/x/y"),
    false,
    "stream URL is not an eval URL"
  );
});

test("isLDStreamUrl: matches real stream URL, rejects unrelated", () => {
  const real =
    "https://clientstream.launchdarkly.com/eval/5cc8a87be4b564081fd2fd70/abc";
  assert.strictEqual(core.isLDStreamUrl(real), true);
  assert.strictEqual(core.isLDStreamUrl("https://example.com/sse"), false);
  assert.strictEqual(
    core.isLDStreamUrl(
      "https://clientsdk.launchdarkly.com/sdk/evalx/x/contexts/y"
    ),
    false,
    "eval URL is not a stream URL"
  );
});

test("URL matchers tolerate non-string (Request-like) inputs", () => {
  const reqLike = {
    url: "https://clientsdk.launchdarkly.com/sdk/evalx/env/contexts/ctx",
  };
  assert.strictEqual(core.isLDEvalUrl(reqLike), true);
  assert.strictEqual(core.isLDEvalUrl(null), false);
  assert.strictEqual(core.isLDEvalUrl(undefined), false);
});
