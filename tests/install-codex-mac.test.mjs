import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifestInfo } from "../scripts/install-codex-mac.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const scriptPath = path.join(root, "scripts", "install-codex-mac.mjs");
const commandPath = path.join(root, "install-macos.command");
const source = fs.readFileSync(scriptPath, "utf8");

const manifest = {
  codexVersion: "26.1013.40934",
  sources: {
    macos: {
      arm64: {
        sha256: "37BD7189EC7D0580B265F3F3CBA5FFBA9CAE90A0D72482241CE57414D97D6505",
        contentLength: 787907132,
        minimumSystemVersion: "13.0",
        bundleShortVersion: "26.1013.40934",
        bundleIdentifier: "com.openai.codex",
        downloadable: true,
        status: "downloadable",
      },
      x64: {
        sha256: "2a89a3a8d4d67280bff748baa05974afa9361f9f32563eb34593a52dadc52f14",
        contentLength: 775095472,
        minimumSystemVersion: "13.0",
        bundleShortVersion: "26.1013.40934",
        bundleIdentifier: "com.openai.codex",
        downloadable: true,
        status: "downloadable",
      },
    },
    windows: { version: "26.1013.4894.0" },
  },
};

test("macOS 清单能按架构取出 arm64 信息", () => {
  const info = readManifestInfo(manifest, "arm64");
  assert.equal(info.version, "26.1013.40934");
  assert.equal(info.minimumSystemVersion, "13.0");
  assert.equal(info.bundleIdentifier, "com.openai.codex");
  assert.equal(info.contentLength, 787907132);
  assert.equal(info.downloadable, true);
});

test("arm64 与 x64 不串味", () => {
  const arm = readManifestInfo(manifest, "arm64");
  const x64 = readManifestInfo(manifest, "x64");
  assert.notEqual(arm.sha256, x64.sha256);
  assert.notEqual(arm.contentLength, x64.contentLength);
});

test("sha256 统一转小写，便于与本地计算值比对", () => {
  const info = readManifestInfo(manifest, "arm64");
  assert.equal(info.sha256, info.sha256.toLowerCase());
  assert.equal(info.sha256.length, 64);
});

test("未知架构返回 null 而不是抛错", () => {
  assert.equal(readManifestInfo(manifest, "ia32"), null);
});

test("缺 sources.macos 返回 null，由调用方兜底继续下载", () => {
  assert.equal(readManifestInfo({ sources: { windows: {} } }, "arm64"), null);
  assert.equal(readManifestInfo({}, "arm64"), null);
  assert.equal(readManifestInfo(null, "arm64"), null);
});

test("清单标记不可下载时如实报告", () => {
  const blocked = {
    sources: { macos: { arm64: { downloadable: false } } },
  };
  assert.equal(readManifestInfo(blocked, "arm64").downloadable, false);
});

test("只走 https，脚本内无明文 http 字面量", () => {
  const httpLiterals = source.match(/["'`]http:\/\/[^"'`]*["'`]/g) || [];
  assert.deepEqual(httpLiterals, [], `发现明文 http: ${httpLiterals.join(", ")}`);
});

test("注明安装包镜像来源（MIT 归属）", () => {
  assert.ok(
    source.includes("https://github.com/Wangnov/codex-app-mirror"),
    "应注明镜像仓库地址",
  );
  assert.ok(/MIT/.test(source), "应标明镜像项目许可证");
  assert.ok(/不托管安装包|不重打包/.test(source), "应说明不托管、不重打包");
});

test("明确声明 macOS 不做汉化", () => {
  // 用户装完发现界面还是英文会差评，脚本和入口都必须提前说清
  assert.ok(/没有简体中文|没有中文界面/.test(source), "脚本应说明 mac 无中文界面");
  const command = fs.readFileSync(commandPath, "utf8");
  assert.ok(/没有简体中文|中文界面/.test(command), "入口脚本也应说明");
});

test("用 ditto 而非 cp，保留代码签名", () => {
  assert.ok(source.includes('"ditto"'), "应使用 ditto 复制 App");
  assert.ok(!/run\("cp",/.test(source), "不应使用 cp 复制 .app");
});

test("下载后校验 SHA-256，不匹配必须删除文件", () => {
  assert.ok(source.includes("SHA-256 不匹配"), "应有不匹配的报错");
  const idx = source.indexOf("SHA-256 不匹配");
  const before = source.slice(Math.max(0, idx - 200), idx);
  assert.ok(before.includes("rmSync"), "不匹配时应先删除已下载文件");
});

test(".command 入口存在、是 LF、有 shebang", () => {
  assert.ok(fs.existsSync(commandPath), "缺少 install-macos.command");
  const bytes = fs.readFileSync(commandPath);
  assert.ok(!bytes.includes(13), ".command 必须是 LF 换行，否则 macOS 报 bad interpreter");
  const text = bytes.toString("utf8");
  assert.ok(text.startsWith("#!/bin/bash"), "必须已有 shebang");
  assert.ok(text.includes("install-codex-mac.mjs"), "应调用 mac 安装脚本");
  assert.ok(text.includes("cd \"$(dirname \"$0\")\""), "应先切到自身目录");
});

test(".gitattributes 把 .command 固定为 LF", () => {
  const attrs = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
  assert.ok(/\*\.command\s+text\s+eol=lf/.test(attrs), ".command 应强制 LF");
});
