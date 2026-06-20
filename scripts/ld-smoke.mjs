#!/usr/bin/env node
/*
 * Live LaunchDarkly API smoke test.
 *
 * Validates a Reader-scoped token end-to-end WITHOUT putting the secret in code:
 *   LD_TOKEN=xxx npm run smoke:ld
 *   LD_TOKEN=xxx LD_BASE=https://app.eu.launchdarkly.com npm run smoke:ld
 *
 * Hits GET /projects?expand=environments and GET /flags/{firstProject}?env={firstEnv},
 * then prints counts + one normalized sample flag. The token is read from the
 * environment only; it is never logged.
 *
 * Reuses the SAME pure shaping logic the extension uses (src/ldapi.js) so what
 * you see here matches the popup.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ld = require(path.join(__dirname, "..", "src", "ldapi.js"));

const TOKEN = process.env.LD_TOKEN;
const BASE = (process.env.LD_BASE || "https://app.launchdarkly.com").replace(
  /\/+$/,
  ""
);
const LD_API_VERSION = "20240415";

if (!TOKEN) {
  console.error(
    [
      "ERROR: LD_TOKEN is not set.",
      "",
      "Create a Reader-scoped access token in LaunchDarkly:",
      "  Account settings -> Authorization -> Access tokens -> Create token",
      "  Role: Reader. Copy the token (shown once).",
      "",
      "Then run:",
      "  LD_TOKEN=api-xxxxxxxx npm run smoke:ld",
      "  (EU/US: add LD_BASE=https://app.eu.launchdarkly.com or .us)",
    ].join("\n")
  );
  process.exit(2);
}

async function ldGet(pathOrHref) {
  const url = BASE + pathOrHref;
  const resp = await fetch(url, {
    headers: {
      Authorization: TOKEN, // RAW token, no Bearer
      "LD-API-Version": LD_API_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await resp.json());
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${resp.status} for ${pathOrHref} ${detail}`);
  }
  return resp.json();
}

async function main() {
  console.log(`Base: ${BASE}  (token: ${TOKEN.length} chars, not shown)`);

  // 1) Projects
  const projBody = await ldGet("/api/v2/projects?expand=environments");
  const projects = ld.normalizeProjects(projBody.items || []);
  console.log(`Projects: ${projects.length}`);
  if (!projects.length) {
    console.log("No projects visible to this token.");
    return;
  }
  const p0 = projects[0];
  console.log(
    `  first project: ${p0.key} (${p0.environments.length} env(s))`
  );
  p0.environments.forEach((e) =>
    console.log(`    env ${e.key} -> client-side ID ${e.clientSideId}`)
  );

  if (!p0.environments.length) {
    console.log("First project has no environments; stopping.");
    return;
  }
  const env0 = p0.environments[0];

  // 2) Flags (paginated)
  let collected = [];
  let next = `/api/v2/flags/${encodeURIComponent(
    p0.key
  )}?env=${encodeURIComponent(env0.key)}&summary=1`;
  let pages = 0;
  while (next && pages < 100) {
    const body = await ldGet(next);
    pages++;
    if (Array.isArray(body.items)) collected = collected.concat(body.items);
    next = ld.parseNextLink(body);
  }
  const flags = ld.normalizeFlags(collected, env0.key);
  const clientSide = flags.filter((f) => f.clientSideAvailable);
  console.log(
    `Flags in ${p0.key}/${env0.key}: ${flags.length} total (${pages} page(s)), ${clientSide.length} client-side / interceptable`
  );
  if (flags.length) {
    console.log("Sample normalized flag:");
    console.log(JSON.stringify(flags[0], null, 2));
  }
  console.log("OK.");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err.message);
  process.exit(1);
});
