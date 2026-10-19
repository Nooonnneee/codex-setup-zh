import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IN_PLACE_MARKER_MODE,
  buildInPlaceMarker,
  resolveInPlaceMarkerVersion,
} from "../scripts/localization-patches.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "..", "scripts", "patch-codex-zh-cn.mjs");

// ── 背景（2026-09-22 客户机实测）────────────────────────────────────────────
// 便携版汉化「明明打进去了」，客户端却报
//   「Codex 汉化失败：汉化后置校验未通过；已执行回滚」。
//
// 根因：工具只在**商店版**（`isWindowsAppsInstall(app)` 为真）才写原地汉化标记
// ⇒ 便携版永远没有 `~/.codex/zh-cn-inplace.json` ⇒ 客户端 `in_place_localized()`
// 判「未汉化」⇒ `apply()` 后置校验失败 ⇒ **自动回滚，把刚打好的补丁拆掉**。
// （0.1.96 修好形态判定之后，便携版才**第一次**真正跑到这一步。）
//
// 下面把两条钉住：① 写标记是收尾动作本身、与形态无关；
// ② 标记里的 `version` 必须与客户端 `installed_version()` 同口径，
//    否则客户端第 ② 条校验照样不过、照样回滚。

test("标记结构：schema=1 / mode=in-place / 记下 sourceApp 与 version", () => {
  const marker = buildInPlaceMarker({
    app: "C:\\Users\\someone\\AppData\\Local\\Programs\\Codex",
    version: "26.903.8094.0",
  });
  assert.equal(marker.schema, 1);
  assert.equal(marker.mode, IN_PLACE_MARKER_MODE);
  assert.equal(marker.mode, "in-place");
  assert.equal(
    marker.sourceApp,
    "C:\\Users\\someone\\AppData\\Local\\Programs\\Codex",
  );
  assert.equal(marker.version, "26.903.8094.0");
  assert.equal(typeof marker.patchedAt, "string");
  assert.ok(marker.patchedAt.length > 0);
});

test("拿不到版本就写 null —— 客户端据此判失效，不会把旧汉化误认为新的", () => {
  assert.equal(buildInPlaceMarker({ app: "C:\\portable" }).version, null);
  assert.equal(
    buildInPlaceMarker({ app: "C:\\portable", version: "" }).version,
    null,
  );
  assert.equal(buildInPlaceMarker().sourceApp, null);
});

test("版本口径：受管便携优先读 .codex-managed，注册包才回退清单", () => {
  // 受管便携：客户端 `installed_version()` 读 `.codex-managed` 的 `version`
  // ⇒ 这里必须给同一个值（故意让清单版本不同，钉住优先级）。
  assert.equal(
    resolveInPlaceMarkerVersion({
      managedVersion: "26.915.1.0",
      manifestVersion: "9.9.9.9",
    }),
    "26.915.1.0",
  );
  // 注册包：客户端读清单 `Identity/@Version`
  assert.equal(
    resolveInPlaceMarkerVersion({ manifestVersion: "1.2.3.4" }),
    "1.2.3.4",
  );
  assert.equal(resolveInPlaceMarkerVersion({}), null);
  assert.equal(resolveInPlaceMarkerVersion(), null);
});

/** 取源码里某个顶层函数的完整文本（按大括号配平）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 function ${name}(`);
  let depth = 0;
  let begun = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") {
      depth += 1;
      begun = true;
    } else if (ch === "}") {
      depth -= 1;
      if (begun && depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`function ${name} 的大括号不配平`);
}

/** 去掉行注释与块注释 —— 守卫要看的是**代码**，注释里引用旧写法不算违规。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

for (const [label, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`源码守卫：${label} 原地汉化收尾无条件写标记`, () => {
    const body = stripComments(
      extractFunction(
        fs.readFileSync(scriptPath, "utf8").replace(/\r?\n/g, newline),
        "finalizeInPlaceLocalization",
      ),
    );
    assert.match(body, /buildInPlaceMarker\(/, "收尾里必须写标记");
    assert.doesNotMatch(
      body,
      /if \(isWindowsAppsInstall\(app\)\)/,
      "又出现了「只有商店版才写标记」的旧条件 —— 便携版会被判未汉化、打完再被回滚",
    );
    assert.match(
      body,
      /readManagedInstallVersion\(/,
      "受管便携要按 .codex-managed 取版本",
    );
    assert.match(body, /readSourcePackageVersion\(/, "注册包要回退到包清单版本");
    // 真正的旧条件仍必须被守卫发现，不能为兼容 CRLF 放宽规则。
    assert.match(
      stripComments(`if (isWindowsAppsInstall(app)) {${newline}  buildInPlaceMarker();${newline}}`),
      /if \(isWindowsAppsInstall\(app\)\)/,
    );
  });
}

test("源码守卫：收尾不再依赖 installInfo（findCodexInstall 的返回里没有 version 字段）", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /finalizeInPlaceLocalization\(app\);/);
  assert.doesNotMatch(
    source,
    /finalizeInPlaceLocalization\(app, installInfo\)/,
  );
});
