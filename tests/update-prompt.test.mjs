import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { applyUpdatePromptPatches } from "../scripts/localization-patches.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const translations = JSON.parse(
  fs.readFileSync(
    path.join(root, "resources", "update-prompt-zh-CN.json"),
    "utf8",
  ),
);

// 这两句是 Codex 26.915.4065.0 的 `.vite/build/bootstrap-DK4EfNwt.js` 里
// `showCheckResult` 那一支的原文（其余部分省略）。写在这里当**指纹**：
// 哪天 Codex 换了写法，这个测试不会红（替换本来就是「匹配不到就跳过」），
// 但 review 时能一眼看出我们针对的是哪段代码。
const SAMPLE = [
  "async showCheckResult(e){switch(e){",
  "case`up-to-date`:await o.dialog.showMessageBox({type:`info`,buttons:[`OK`],defaultId:0,noLink:!0,message:`${o.app.getName()} is up to date.`});return;",
  "case`update-available-in-store`:await o.dialog.showMessageBox({type:`info`,buttons:[`OK`],defaultId:0,noLink:!0,message:`${o.app.getName()} update is available.`,detail:`Open Microsoft Store to install the update.`});return;",
  "}}",
].join("");

test("update prompt patch replaces the store-update guidance", () => {
  const result = applyUpdatePromptPatches(SAMPLE, translations.replacements);

  assert.equal(result.changed, true);
  assert.equal(result.applied, 2);
  assert.equal(result.ambiguous, 0);
  assert.ok(
    !result.source.includes("Open Microsoft Store to install the update."),
  );
  assert.ok(!result.source.includes("} update is available."));
  assert.ok(result.source.includes("一键汉化"));
  // 只动文案：更新逻辑本身一个字没变。
  assert.ok(result.source.includes("update-available-in-store"));
  assert.ok(
    result.source.includes("trySilentDownloadAndInstallStoreUpdates") === false,
  );
  assert.ok(result.source.includes("showCheckResult"));
});

test("update prompt patch is idempotent", () => {
  const first = applyUpdatePromptPatches(SAMPLE, translations.replacements);
  const second = applyUpdatePromptPatches(
    first.source,
    translations.replacements,
  );

  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("an ambiguous occurrence is skipped instead of guessed", () => {
  // 同一句文案出现两次时分不清哪一处才是「去商店更新」那句 —— 宁可不改。
  const doubled = SAMPLE + SAMPLE;

  const result = applyUpdatePromptPatches(doubled, translations.replacements);

  assert.equal(result.applied, 0);
  assert.equal(result.ambiguous, 2);
  assert.equal(result.source, doubled);
});

test("an unknown Codex layout is left untouched", () => {
  const result = applyUpdatePromptPatches(
    "console.log('no updater here')",
    translations.replacements,
  );

  assert.equal(result.changed, false);
  assert.equal(result.applied, 0);
  assert.equal(result.ambiguous, 0);
});

test("the shipped replacements only touch UI copy", () => {
  assert.ok(translations.replacements.length >= 2);
  for (const pair of translations.replacements) {
    assert.equal(Array.isArray(pair), true);
    assert.equal(pair.length, 2);
    const [from, to] = pair;
    // 每条都必须是「英文界面文案 → 中文界面文案」，不能顺手改代码。
    assert.ok(from.length > 0 && to.length > 0);
    assert.ok(/[A-Za-z]/.test(from));
    assert.ok(/[\u4e00-\u9fff]/.test(to));
    assert.ok(!from.includes("=>") && !from.includes("return"));
  }
});
