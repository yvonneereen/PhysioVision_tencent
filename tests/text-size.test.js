import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  getTextSize,
  setTextSize,
  TEXT_SIZE_OPTIONS,
} from "../text-size.js";

assert.deepEqual(
  TEXT_SIZE_OPTIONS.map(({ value, percent }) => [value, percent]),
  [["standard", 100], ["large", 125], ["extra-large", 150]]
);

const saved = new Map();
const storage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
};
const selectors = [{
  value: "",
  dataset: {},
  addEventListener() {},
}];
const status = { textContent: "" };
const documentObject = {
  documentElement: { dataset: {} },
  querySelectorAll: () => selectors,
  getElementById: () => status,
};

assert.equal(setTextSize("large", { documentObject, storage }), true);
assert.equal(getTextSize(), "large");
assert.equal(documentObject.documentElement.dataset.textSize, "large");
assert.equal(selectors[0].value, "large");
assert.equal(saved.get("physiovision.text-size.v1"), "large");
assert.equal(status.textContent, "Text size changed to Large.");

assert.equal(setTextSize("extra-large", { documentObject, storage }), true);
assert.equal(documentObject.documentElement.dataset.textSize, "extra-large");
assert.equal(setTextSize("unsupported", { documentObject, storage }), false);

setTextSize("standard", {
  persist: false,
  announce: false,
  documentObject,
  storage,
});

const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
assert.match(css, /html\[data-text-size="large"\]\s*\{\s*font-size:\s*1\.25rem/);
assert.match(css, /html\[data-text-size="extra-large"\]\s*\{\s*font-size:\s*1\.5rem/);
assert.match(css, /body\s*\{[\s\S]*?font-size:\s*1\.125rem;[\s\S]*?line-height:\s*1\.55;/);
assert.match(css, /\.rx-form select, \.rx-form input\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
assert.match(css, /\.rx-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 0\.85fr\) minmax\(0, 0\.85fr\) minmax\(0, 1\.3fr\);[\s\S]*?min-width:\s*0;/);
assert.match(css, /\.rx-row label\s*\{[\s\S]*?min-width:\s*0;/);
assert.match(css, /\.rx-row label > span\s*\{[\s\S]*?white-space:\s*nowrap;/);
assert.doesNotMatch(css, /font-size:[^;]*px/, "font sizes should use scalable units");
assert.doesNotMatch(css, /font-size:\s*0\.[0-9]+rem/, "secondary text must not be below 16px at the standard setting");
assert.equal((html.match(/data-text-size-selector/g) ?? []).length, 2);
assert.match(html, /<option value="standard">Standard<\/option>/);
assert.match(html, /<option value="large">Large<\/option>/);
assert.match(html, /<option value="extra-large">Extra large<\/option>/);

console.log("text-size preference tests passed");
