import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_BOOTSTRAP_MARKER,
  LEGACY_RUNTIME_BOOTSTRAP_MARKER,
  buildRuntimeBootstrap,
  hasRuntimeBootstrap,
  injectRuntimeBootstrapSource,
  needsRuntimeBootstrapUpgrade,
  resolveRuntimeDir,
  resolveRuntimeStatusPath,
} from "../scripts/localization-runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const RUNTIME_DIR = path.join(projectRoot, "runtime");

test("runtime 目录里该有的文件都在", () => {
  for (const name of ["main.cjs", "preload-localization.cjs", "VERSION.txt"]) {
    assert.ok(
      existsSync(path.join(RUNTIME_DIR, name)),
      `缺少 runtime/${name}`,
    );
  }
});

test("注入的引导指向本工具的 runtime 目录，不含客户端私有目录", () => {
  const source = buildRuntimeBootstrap(RUNTIME_DIR);
  assert.ok(source.includes(RUNTIME_BOOTSTRAP_MARKER));
  assert.ok(source.includes("main.cjs"));
  assert.ok(
    !source.includes("FMKJ Connect"),
    "引导不应再引用 FMKJ Connect 私有目录",
  );
  assert.ok(
    !/"Tools"/.test(source),
    "引导不应再按 Tools 子目录挑版本",
  );
});

test("注入是幂等的：重复注入不改变内容", () => {
  const first = injectRuntimeBootstrapSource("var original = 1;", RUNTIME_DIR);
  assert.equal(first.changed, true);
  const second = injectRuntimeBootstrapSource(first.source, RUNTIME_DIR);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("旧版 FMKJ 引导会被整块替换掉，不留旧代码", () => {
  const legacy =
    `${LEGACY_RUNTIME_BOOTSTRAP_MARKER}\n` +
    `require("C:/old/path/main.cjs");\n` +
    `var after = 2;\n`;
  const result = injectRuntimeBootstrapSource(legacy, RUNTIME_DIR);
  assert.equal(result.changed, true);
  assert.ok(result.source.includes(RUNTIME_BOOTSTRAP_MARKER));
  assert.ok(!result.source.includes(LEGACY_RUNTIME_BOOTSTRAP_MARKER));
  assert.ok(result.source.includes("var after = 2;"), "不能吞掉后续代码");
});

test("能识别需要升级的旧注入", () => {
  const legacy = `${LEGACY_RUNTIME_BOOTSTRAP_MARKER}\nrequire("x");\n`;
  assert.equal(hasRuntimeBootstrap(legacy), true);
  assert.equal(needsRuntimeBootstrapUpgrade(legacy), true);
  const current = injectRuntimeBootstrapSource("var a=1;", RUNTIME_DIR).source;
  assert.equal(hasRuntimeBootstrap(current), true);
  assert.equal(needsRuntimeBootstrapUpgrade(current), false);
});

test("运行时状态文件落在 ~/.codex 下", () => {
  const statusPath = resolveRuntimeStatusPath("C:/Users/x/.codex");
  assert.equal(
    path.normalize(statusPath),
    path.normalize("C:/Users/x/.codex/zh-cn-runtime-status.json"),
  );
  assert.equal(path.normalize(resolveRuntimeDir(projectRoot)), path.normalize(RUNTIME_DIR));
});
