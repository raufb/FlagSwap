/*
 * Rasterize FlagSwap PNG icons from the SVG sources in src/icons/.
 * SVGs are the source of truth; PNGs are exports. Re-run after editing an SVG:
 *   node scripts/gen-icons.mjs
 *
 * Per the logo handoff: sizes <=32 use the tighter "tile-small" variant
 * (larger rx-relative corners, heavier stroke) so the mark stays legible;
 * sizes >=48 use the standard "tile". 128 is added for the Chrome Web Store.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.resolve(__dirname, "..", "src", "icons");

// size -> source svg
const JOBS = [
  [16, "tile-small.svg"],
  [32, "tile-small.svg"],
  [48, "tile.svg"],
  [96, "tile.svg"],
  [128, "tile.svg"],
];

const svgCache = new Map();
const read = (f) =>
  svgCache.get(f) ?? svgCache.set(f, fs.readFileSync(path.join(ICONS, f), "utf8")).get(f);

const browser = await chromium.launch();
try {
  for (const [size, src] of JOBS) {
    const svg = read(src);
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    // Inline the SVG at exact pixel size; transparent page so rounded
    // corners stay transparent.
    const html = `<!doctype html><meta charset="utf8">
      <style>html,body{margin:0;padding:0;background:transparent}
      svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
    await page.setContent(html, { waitUntil: "networkidle" });
    const out = path.join(ICONS, `icon-${size}.png`);
    await page.locator("svg").screenshot({ path: out, omitBackground: true });
    await page.close();
    const bytes = fs.statSync(out).size;
    console.log(`icon-${size}.png  (${src}, ${bytes} B)`);
  }
} finally {
  await browser.close();
}
