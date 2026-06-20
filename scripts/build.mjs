/*
 * FlagSwap build: one shared src/, per-browser manifests.
 *
 * Produces dist/<target>/ for each target by deep-merging manifest.base.json
 * with manifest.<target>.json and copying src/ verbatim. The JS/HTML/CSS is
 * identical across targets; only the manifest (background model + gecko id)
 * differs. Load dist/chrome or dist/firefox as an unpacked extension.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
const TARGETS = ["chrome", "firefox"];

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Deep-merge: objects merge recursively; arrays/primitives are replaced.
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const av = a[k];
    const bv = b[k];
    if (
      av && bv &&
      typeof av === "object" && typeof bv === "object" &&
      !Array.isArray(av) && !Array.isArray(bv)
    ) {
      out[k] = deepMerge(av, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const base = readJSON(path.join(ROOT, "manifest.base.json"));
fs.rmSync(DIST, { recursive: true, force: true });

for (const t of TARGETS) {
  const overrides = readJSON(path.join(ROOT, `manifest.${t}.json`));
  const manifest = deepMerge(base, overrides);
  const outDir = path.join(DIST, t);
  copyDir(SRC, path.join(outDir, "src"));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  console.log(`built dist/${t} (background: ${Object.keys(manifest.background)[0]})`);
}
