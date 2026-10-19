import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ── 这一组测的是**真实的分类代码**（不是纯函数）─────────────────────────────
// 2026-09-22 客户机事故：客户端的受管便携安装根目录里也有一份 `AppxManifest.xml`，
// 而 `status` 与 `resolvePatchTarget` 当年都只看「有没有清单」⇒ 便携版被判成商店版
// ⇒ 汉化报「没有找到 Microsoft Store 安装的 Codex」、回滚报同一句。顺带还有两个
// 用户可见的错：为一个不需要提权的操作弹 UAC、以及提示「要先开开发者模式」。
//
// `status` 全程只读（不关进程、不写盘、不注册），所以可以拿真目录当夹具跑。
// `install` / `uninstall` 会 taskkill 真实 Codex 进程，**不能**这样测。

const here = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(here, "..", "scripts", "patch-codex-zh-cn.mjs");

const MANIFEST = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">',
  '  <Identity Name="OpenAI.Codex" Publisher="CN=OpenAI" Version="26.915.4065.0" ProcessorArchitecture="x64" />',
  "  <Properties>",
  "    <DisplayName>ChatGPT</DisplayName>",
  "  </Properties>",
  "</Package>",
].join("\n");

/**
 * 造一份「像 Codex 安装」的目录树。
 *
 * `flatten` = true 造客户端便携版那种布局（`app/**` 已被摊平到根目录），
 * 否则造商店包那种布局（多一层 `app/`）。
 */
function makeInstall(root, { flatten, marker }) {
  const appRoot = flatten ? root : path.join(root, "app");
  fs.mkdirSync(path.join(appRoot, "resources"), { recursive: true });
  if (flatten) {
    fs.writeFileSync(path.join(appRoot, "resources", "app.asar"), "fixture");
    fs.writeFileSync(path.join(appRoot, "ChatGPT.exe"), "fixture");
  } else {
    fs.writeFileSync(path.join(appRoot, "resources", "app.asar"), "fixture");
    fs.writeFileSync(path.join(appRoot, "ChatGPT.exe"), "fixture");
  }
  // 清单写在**包根**（两种形态都是这样）。
  fs.writeFileSync(path.join(root, "AppxManifest.xml"), MANIFEST, "utf8");
  if (marker) {
    fs.writeFileSync(
      path.join(root, ".codex-managed"),
      JSON.stringify({ schemaVersion: 1, layout: "flatten-v1" }),
      "utf8",
    );
  }
  return root;
}

function runStatus(dir) {
  const result = spawnSync(
    process.execPath,
    [entrypoint, "status", "--codex-path", dir, "--json"],
    { encoding: "utf8", windowsHide: true, timeout: 120000 },
  );
  const line = String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{"))
    .pop();
  assert.ok(line, `status 没有输出 JSON：${result.stdout}${result.stderr}`);
  return JSON.parse(line);
}

test("受管便携安装：判成 in-place，不要求提权、不提示开发者模式", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmkj-status-portable-"));
  try {
    // 关键：**既写标记、又写清单** —— 这正是当年判反的形态。
    const root = makeInstall(path.join(tmp, "Codex"), {
      flatten: true,
      marker: true,
    });

    const report = runStatus(root);

    assert.equal(report.codexFound, true);
    assert.equal(report.installKind, "managed-portable");
    assert.equal(report.localizationMode, "in-place");
    assert.equal(report.requiresAdmin, false, "便携版不该要管理员权限");
    assert.equal(report.developerMode, true, "便携版与开发者模式无关");

    const text = report.messages.join("\n");
    assert.ok(
      !/Microsoft Store|开发者模式/.test(text),
      `便携版不该出现商店版话术：${text}`,
    );
    assert.ok(/便携版/.test(text), `应当说明这是便携版：${text}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("有清单但没注册：按 unmanaged 处理，同样不要求提权", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmkj-status-unmanaged-"));
  try {
    // 手工解包的副本 / 旧版本残留 / D:\CodexTest 那一类：有清单，但系统里
    // 查不到这个包身份。对它走商店路线就是去找一个不存在的源。
    const root = makeInstall(path.join(tmp, "CodexTest"), {
      flatten: false,
      marker: false,
    });

    const report = runStatus(root);

    assert.equal(report.codexFound, true);
    assert.equal(report.installKind, "unmanaged");
    assert.equal(report.localizationMode, "in-place");
    assert.equal(report.requiresAdmin, false);

    const text = report.messages.join("\n");
    assert.ok(
      !/没有找到 Microsoft Store/.test(text),
      `不该在这里报「没有找到商店版」：${text}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("已注册形态（WindowsApps 路径）：仍走商店路线，照旧要求提权", () => {
  // 反向断言：修判据不能把**真正的商店版**一起改坏 —— 它必须继续走
  // 「复制副本 + 松散注册」，那条路要提权。（包身份用路径判定，
  // 夹具造在 `WindowsApps` 目录下即可，不需要真装包。）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmkj-status-store-"));
  try {
    const root = makeInstall(
      path.join(tmp, "WindowsApps", "OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0"),
      { flatten: false, marker: false },
    );

    const report = runStatus(root);

    assert.equal(report.codexFound, true);
    assert.equal(report.installKind, "store");
    assert.equal(report.localizationMode, "store-register");
    assert.equal(report.requiresAdmin, true, "商店版要复制副本，这一步必须提权");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
