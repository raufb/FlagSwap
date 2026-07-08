/*
 * FlagSwap package: zip each built target for distribution.
 *
 * Expects dist/<target>/ to already exist (run `npm run build` first; the
 * `package` npm script chains them). Produces dist/packages/flagswap-<version>-
 * <target>.zip with manifest.json at the archive root — the layout AMO signing
 * and the Chrome Web Store both require. The firefox zip is what you upload to
 * AMO (listed or unlisted signing); the chrome zip is for the Web Store or
 * `Load unpacked` after unzipping.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, "packages");
const TARGETS = ["chrome", "firefox"];

const { version } = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.base.json"), "utf8")
);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const t of TARGETS) {
  const srcDir = path.join(DIST, t);
  if (!fs.existsSync(path.join(srcDir, "manifest.json"))) {
    throw new Error(`missing dist/${t} — run "npm run build" first`);
  }
  const zipPath = path.join(OUT, `flagswap-${version}-${t}.zip`);
  // Zip from inside the target dir so manifest.json sits at the archive root.
  // -r recurse, -X drop extra file attributes, -9 max compression.
  execFileSync("zip", ["-r", "-X", "-9", zipPath, "."], {
    cwd: srcDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`packaged ${path.relative(ROOT, zipPath)} (${kb} KB)`);
}
