import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(new URL("../scripts/patch-codex-zh-cn.mjs", import.meta.url), "utf8");
const section = source.slice(source.indexOf("const CODEX_PS_PATH_MATCH"), source.indexOf("function stopCodex("));
function load(result) {
  const scope = { spawnSync: () => result };
  vm.runInNewContext(section + "\nthis.pattern = CODEX_PS_PATH_MATCH; this.detect = listRunningCodexProcesses;", scope);
  return scope;
}
test("matches ordinary Codex installation without matching unrelated ChatGPT", () => {
  const pattern = new RegExp(load({status: 0, stdout: ""}).pattern, "i");
  assert.ok(pattern.test(String.raw`C:\Users\Administrator\AppData\Local\Programs\Codex\ChatGPT.exe`));
  assert.ok(pattern.test(String.raw`C:\Users\other\AppData\Local\Programs\codex\app\ChatGPT.exe`));
  assert.ok(!pattern.test(String.raw`C:\Users\other\AppData\Local\Programs\ChatGPT\ChatGPT.exe`));
  assert.ok(!pattern.test(String.raw`C:\Programs\CodexOther\ChatGPT.exe`));
});
test("detection failures cannot be mistaken for an exited application", () => {
  for (const result of [{status: 1, stdout: ""}, {status: null, error: new Error("timeout") }]) {
    assert.throws(() => load(result).detect(), /无法确认 Codex/);
  }
  assert.equal(load({status: 0, stdout: ""}).detect().length, 0);
  assert.equal(load({status: 0, stdout: "ChatGPT.exe"}).detect()[0], "ChatGPT.exe");
});
