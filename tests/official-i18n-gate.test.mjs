import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  OFFICIAL_I18N_GATE_MARKER,
  RUNTIME_BOOTSTRAP_MARKER,
  injectRuntimeBootstrapSource,
  patchOfficialI18nGateSource,
} from "../scripts/localization-patches.mjs";

// 开源版引导需要一个真实的语言包目录（注入时编译期内联进主进程）。
const RUNTIME_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime",
);

const prefix = "locale_source Failed to load locale messages ";
const gate =
  "a=b(`72216192`),c;d[0]===a?c=d[1]:(c=a?.get(`enable_i18n`,!1),d[0]=a,d[1]=c)";

test("official i18n gate is enabled only for one exact recognized gate", () => {
  const result = patchOfficialI18nGateSource(prefix + gate);
  assert.ok(result);
  assert.equal(result.changed, true);
  assert.match(result.source, /a=b\(`72216192`\),c;c=!0/);
  assert.ok(result.source.includes(OFFICIAL_I18N_GATE_MARKER));
});

test("runtime bootstrap replaces a legacy hardcoded tool path", () => {
  // 老版本把语言包目录名写死在引导里（`codex-zh-cn-0.1.4-fmkj7`）。客户端解压出来的
  // 其实是别的目录名 ⇒ `require` 抛错被吞掉，「汉化提示成功、动态页面却没汉化」。
  // 开源版索性把本工具的 runtime/ 目录编译期写进引导，注入时必须把老代码整块换掉。
  const legacy =
    "/* fmkj-runtime-bootstrap-v1 */\n" +
    '(() => { const path = require("node:path"); ' +
    'require(path.join(process.env.LOCALAPPDATA, "FMKJ Connect", "Tools", ' +
    '"codex-zh-cn-0.1.4-fmkj7", "runtime", "main.cjs")); })();\n';

  const upgraded = injectRuntimeBootstrapSource(`main()\n${legacy}`, RUNTIME_DIR);

  assert.equal(upgraded.changed, true);
  assert.ok(!upgraded.source.includes("codex-zh-cn-0.1.4-fmkj7"));
  assert.ok(!upgraded.source.includes("FMKJ Connect"));
  assert.ok(upgraded.source.includes("main.cjs"));
  // 老代码整块被换掉，不是又叠了一层。
  assert.equal(upgraded.source.includes(RUNTIME_BOOTSTRAP_MARKER), true);
  assert.equal(upgraded.source.split(RUNTIME_BOOTSTRAP_MARKER).length - 1, 1);
});

test("runtime bootstrap injection is idempotent", () => {
  const first = injectRuntimeBootstrapSource("main()", RUNTIME_DIR);
  const second = injectRuntimeBootstrapSource(first.source, RUNTIME_DIR);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("official i18n gate patch is idempotent", () => {
  const first = patchOfficialI18nGateSource(prefix + gate);
  const second = patchOfficialI18nGateSource(first.source);
  assert.deepEqual(second, {
    source: first.source,
    changed: false,
    recognized: true,
  });
});

test("unknown and ambiguous layouts are left untouched", () => {
  assert.equal(
    patchOfficialI18nGateSource(prefix + "72216192 enable_i18n"),
    null,
  );
  assert.equal(patchOfficialI18nGateSource(prefix + gate + gate), null);
});
