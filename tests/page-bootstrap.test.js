import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

for (const file of ["index.html", "image/index.html"]) {
  test(`${file} starts initPage even when Firebase config resolves after DOMContentLoaded`, async () => {
    const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");

    assert.match(html, /const firebaseConfig = await loadPublicFirebaseConfig\(\)/);
    assert.match(html, /if \(document\.readyState === "loading"\)/);
    assert.match(html, /document\.addEventListener\("DOMContentLoaded", initPage, \{ once: true \}\)/);
    assert.match(html, /else \{\s*initPage\(\);\s*\}/);
  });
}

