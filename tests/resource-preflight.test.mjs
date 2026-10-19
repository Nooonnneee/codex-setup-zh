import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const tool = new URL("../", import.meta.url);
const source = fs.readFileSync(new URL("scripts/patch-codex-zh-cn.mjs", tool), "utf8");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmkj-preflight-"));
  fs.cpSync(tool, path.join(root, "tool"), { recursive: true });
  const app = path.join(root, "app"); const resources = path.join(app, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const asar = path.join(resources, "app.asar"); fs.writeFileSync(asar, "original-asar");
  let touched = false;
  const scope = {
    fs, path, Buffer, console: { log() {} }, resourcesDir: path.join(root, "tool/resources"),
    projectRoot: path.join(root, "tool"), localizationDiagnostic: {}, INSTALL_STEP_TOTAL: 8,
    clearRuntimeVerification() {}, ensureCodexStopped() {}, progressLog() {}, logInfo() {}, logOk() {},
    findCodexInstall: () => ({ app, resources }), assertSourceAsarPatchable() {},
    resolvePatchTarget: () => { touched = true; fs.writeFileSync(path.join(root, "target-prepared"), "prepared"); return { app, resources, mode: "in-place" }; },
    getInstallBackupRoot: () => path.join(root, "backup"), prepareInstallWriteAccess() {}, assertInstallWritable() {},
    backupFile: (file, backup) => { if (fs.existsSync(file)) { fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(file, path.join(backup, path.basename(file))); } },
  };
  vm.createContext(scope);
  // Run the production install function, but isolate OS process control and
  // registration. Resource reads, target preparation and backups use real files.
  const preflight = source.indexOf("function preflightToolResources(");
  if (preflight >= 0) vm.runInContext(source.slice(preflight, source.indexOf("function loadJson(name)", preflight)), scope);
  vm.runInContext(source.slice(source.indexOf("function loadJson(name)"), source.indexOf("/** 旧版错误补丁")), scope);
  vm.runInContext(source.slice(source.indexOf("function install(options)"), source.indexOf("function readManagedInstallVersion(app)")), scope);
  return { root, asar, scope, touched: () => touched, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("missing menu-hardcoded resource fails before preparing target or creating backups", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.root, "tool/resources/menu-hardcoded-zh-CN.json"));
    assert.throws(() => f.scope.install({ relaunch: false }), /menu-hardcoded-zh-CN\.json/);
    assert.equal(f.touched(), false, "incomplete language tool must not prepare/modify target");
    assert.equal(fs.existsSync(path.join(f.root, "backup")), false);
    assert.equal(fs.readFileSync(f.asar, "utf8"), "original-asar");
  } finally { f.dispose(); }
});
for (const relative of [
  "resources/native-menu-zh-CN.json", "resources/menu-hardcoded-zh-CN.json",
  "resources/update-prompt-zh-CN.json", "resources/bundled-plugins-zh-CN.json", "resources/release.json",
  "runtime/main.cjs", "runtime/preload-localization.cjs",
  "launchers/Codex 汉化版.bat", "launchers/launch-codex-zh-cn.bat", "launchers/launch-codex-zh-cn.ps1",
]) {
  test(`missing ${relative} fails before any target preparation`, () => {
    const f = fixture();
    try {
      fs.unlinkSync(path.join(f.root, "tool", relative));
      assert.throws(() => f.scope.install({ relaunch: false }));
      assert.equal(f.scope.localizationDiagnostic.step, "resource_preflight");
      assert.equal(f.touched(), false); assert.equal(fs.readFileSync(f.asar, "utf8"), "original-asar");
    } finally { f.dispose(); }
  });
}
for (const [relative, content] of [
  ["resources/native-menu-zh-CN.json", "[]"], ["resources/menu-hardcoded-zh-CN.json", "{}"],
  ["resources/update-prompt-zh-CN.json", '{"version":1,"replacements":[["File",null]]}'],
  ["resources/bundled-plugins-zh-CN.json", '{"plugin":{"label":42}}'],
  ["resources/release.json", "not json"], ["runtime/main.cjs", "function {"],
  ["runtime/preload-localization.cjs", ""], ["launchers/launch-codex-zh-cn.ps1", ""],
]) {
  test(`invalid ${relative} fails before any target preparation`, () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.root, "tool", relative), content);
      assert.throws(() => f.scope.install({ relaunch: false }));
      assert.equal(f.touched(), false); assert.equal(fs.existsSync(path.join(f.root, "backup")), false);
    } finally { f.dispose(); }
  });
}
test("complete resources are parsed once and preserve translation content", () => {
  const f = fixture();
  try {
    const loaded = f.scope.preflightToolResources();
    assert.equal(Object.keys(loaded).length, 5);
    for (const name of Object.keys(loaded)) assert.deepEqual(JSON.parse(JSON.stringify(loaded[name])), JSON.parse(fs.readFileSync(path.join(f.root, "tool/resources", name), "utf8")));
    assert.equal(f.touched(), false);
  } finally { f.dispose(); }
});
