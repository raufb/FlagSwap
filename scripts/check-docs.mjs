#!/usr/bin/env node
/**
 * Sanity gate for the published pages under docs/ (GitHub Pages source).
 *
 * The privacy policy is a compliance document served to users and to store
 * reviewers, so the cheap structural mistakes — an unclosed tag, a stray
 * remotely-loaded asset — should fail a check rather than a review. Kept
 * dependency-free so it runs anywhere `npm test` does.
 *
 * Checks per HTML file:
 *   1. Tags are balanced and properly nested.
 *   2. No remotely-loaded subresources (<script src>, external stylesheet,
 *      remote <img>/<iframe>) — these pages must be self-contained.
 *   3. Local hrefs point at files that exist.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

// Elements with no closing tag (HTML void elements).
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

function checkBalance(file, html) {
  // Strip comments, then walk every tag.
  const src = html.replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const [, closing, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (VOID.has(name) || attrs.trimEnd().endsWith("/")) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        fail(file, `</${name}> closes <${open ?? "nothing"}>`);
        return;
      }
    } else {
      stack.push(name);
      // <style>/<script> bodies can contain '<'; skip to the close tag.
      if (name === "style" || name === "script") {
        const close = src.indexOf(`</${name}>`, tagRe.lastIndex);
        if (close === -1) {
          fail(file, `unclosed <${name}>`);
          return;
        }
        tagRe.lastIndex = close;
      }
    }
  }
  if (stack.length) fail(file, `unclosed tag(s): ${stack.join(" > ")}`);
}

function checkSelfContained(file, html) {
  const remote = /(?:src|href)\s*=\s*["'](https?:)?\/\//i;
  for (const tag of html.match(/<(script|link|img|iframe)\b[^>]*>/gi) || []) {
    // Outbound <a href> links are fine; these four element types are not.
    if (/rel\s*=\s*["']?(icon|canonical|alternate)/i.test(tag)) continue;
    if (remote.test(tag)) fail(file, `remotely-loaded subresource: ${tag.trim()}`);
  }
}

function checkLocalLinks(file, html) {
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    const href = m[1];
    if (/^(https?:|mailto:|data:|\/\/)/i.test(href)) continue;
    if (!existsSync(join(DOCS, href))) fail(file, `dead local link: ${href}`);
  }
}

const files = readdirSync(DOCS).filter((f) => f.endsWith(".html"));
if (files.length === 0) {
  console.error("check-docs: no HTML files found under docs/");
  process.exit(1);
}

for (const file of files) {
  const html = readFileSync(join(DOCS, file), "utf8");
  checkBalance(file, html);
  checkSelfContained(file, html);
  checkLocalLinks(file, html);
}

if (errors.length) {
  console.error(`check-docs: ${errors.length} problem(s)\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-docs: ${files.length} file(s) OK (${files.join(", ")})`);
