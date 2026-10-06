// Conformance test P21 (follow-up round 2026-10-06): the README ships in the npm tarball and
// is shown on npmjs.com, so every relative link in it must point to a file the package ships;
// anything else 404s there and has to be an absolute GitHub URL instead. "Shipped" follows
// npm: matched by package.json `files` (plain paths and directory prefixes; `!` negations
// are excluded), plus README, LICENSE* and package.json, which npm always packs. No `npm pack`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- adapter (per repo) -------------------------------------------------------------
/** The repo root, relative to this compiled test file (dist/test/…). */
const ROOT = new URL("../../", import.meta.url);
/** The GitHub blob URL prefix a non-shipped link should use instead. */
const GITHUB_BLOB = "https://github.com/maschinenlesbar-org/marktstammdatenregister-cli/blob/main/";
// --------------------------------------------------------------------------------------

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, ROOT)), "utf8");

/** Relative link targets in a markdown text, anchors and titles stripped. */
function relativeTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1]!;
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    targets.push(target.replace(/#.*$/, "").replace(/^\.\//, ""));
  }
  return targets.filter((t) => t !== "");
}

/** True when npm would pack `path` given the `files` allowlist. */
function shipped(path: string, files: readonly string[]): boolean {
  if (/^(?:README(?:\.[^/]*)?|LICEN[CS]E(?:\.[^/]*)?|package\.json)$/i.test(path)) return true;
  return files
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""))
    .some((entry) => path === entry || path.startsWith(`${entry}/`));
}

test("P21: every relative README link points to a file the npm package ships", () => {
  const files = (JSON.parse(read("package.json")) as { files?: string[] }).files ?? [];
  const targets = relativeTargets(read("README.md"));
  const broken = targets.filter((t) => !shipped(t, files));
  assert.deepEqual(
    broken,
    [],
    `README links to files the npm package doesn't ship (they 404 on npmjs.com); ` +
      `link them as ${GITHUB_BLOB}<path> instead: ${broken.join(", ")}`,
  );
});

test("P21: the link check itself", () => {
  assert.deepEqual(relativeTargets("[a](Usage.md#x) [b](https://x.example) [c](#top) [d](mailto:a@b) [e](./LICENSE)"), [
    "Usage.md",
    "LICENSE",
  ]);
  assert.equal(shipped("dist/src/index.js", ["dist/src"]), true);
  assert.equal(shipped("dist/src2", ["dist/src"]), false);
  assert.equal(shipped("x.map", ["!x.map"]), false);
  assert.equal(shipped("LICENSE", []), true);
  assert.equal(shipped("Usage.md", ["LICENSING.md"]), false);
});
