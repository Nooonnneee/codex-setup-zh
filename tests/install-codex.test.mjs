import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifestInfo } from "../scripts/install-codex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "..", "scripts", "install-codex.mjs");
const source = fs.readFileSync(scriptPath, "utf8");

const manifest = {
  schemaVersion: 5,
  sources: {
    windows: {
      version: "26.1013.4894.0",
      packageMoniker: "OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0",
      contentLength: 948993815,
      architectures: {
        x64: {
          architecture: "x64",
          status: "downloadable",
          downloadable: true,
          version: "26.1013.4894.0",
          packageMoniker: "OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0",
          contentLength: 948993815,
        },
        arm64: {
          architecture: "arm64",
          status: "downloadable",
          downloadable: true,
          version: "26.1013.4894.0",
          packageMoniker: "OpenAI.Codex_26.1013.4894.0_arm64__2p2nqsd0c76g0",
          contentLength: 900000000,
        },
      },
    },
  },
};

test("清单能按架构取出 x64 的版本与大小", () => {
  const info = readManifestInfo(manifest, "x64");
  assert.equal(info.version, "26.1013.4894.0");
  assert.equal(info.contentLength, 948993815);
  assert.ok(info.packageMoniker.includes("x64"));
  assert.equal(info.downloadable, true);
});

test("清单能按架构取出 arm64，且与 x64 不串味", () => {
  const info = readManifestInfo(manifest, "arm64");
  assert.ok(info.packageMoniker.includes("arm64"));
  assert.equal(info.contentLength, 900000000);
});

test("未知架构返回 null，而不是抛错", () => {
  assert.equal(readManifestInfo(manifest, "ia32"), null);
});

test("清单缺 sources.windows 时返回 null", () => {
  assert.equal(readManifestInfo({}, "x64"), null);
  assert.equal(readManifestInfo(null, "x64"), null);
});

test("清单缺 architectures 时返回 null，由调用方兜底继续下载", () => {
  assert.equal(
    readManifestInfo({ sources: { windows: { version: "1.0.0" } } }, "x64"),
    null,
  );
});

test("可下载标记为 false 时如实报告", () => {
  const blocked = {
    sources: {
      windows: {
        architectures: { x64: { version: "1", downloadable: false } },
      },
    },
  };
  assert.equal(readManifestInfo(blocked, "x64").downloadable, false);
});

test("只允许 https 下载地址：脚本里没有 http:// 的字面量", () => {
  // 明文 http 会被中间人替换安装包；MSIX 虽有签名，但没有理由留这个口子。
  const httpLiterals = source.match(/["'`]http:\/\/[^"'`]*["'`]/g) || [];
  assert.deepEqual(httpLiterals, [], `发现明文 http 地址: ${httpLiterals.join(", ")}`);
});

test("下载与安装走公开镜像，不指向私有服务", () => {
  assert.ok(
    !/workbench\.fmkj\.top|api\.fmkj\.top|fanmeng\.ai/.test(source),
    "安装脚本不应引用私有分发域名",
  );
  assert.ok(source.includes("MIRROR_ORIGIN"));
});

test("注明安装包镜像来源（MIT 归属）", () => {
  // 安装包来自第三方开源镜像，必须可溯源，否则用户无从判断从哪下载的。
  assert.ok(
    source.includes("https://github.com/Wangnov/codex-app-mirror"),
    "脚本里应注明镜像仓库地址",
  );
  assert.ok(/MIT/.test(source), "应标明镜像项目的许可证");
  assert.ok(
    /不托管安装包|不重打包/.test(source),
    "应说明本工具不托管、不重打包安装包",
  );
});

test("镜像源集中在单一常量，便于换源", () => {
  assert.ok(source.includes("MIRROR_REPO"));
  // 镜像域名只允许出现在常量定义里，别处必须复用常量
  const hardcoded = source.match(/["'`]https:\/\/codexapp\.agentsmirror\.com/g) || [];
  assert.ok(
    hardcoded.length <= 1,
    `镜像域名应只在常量里出现一次，实际 ${hardcoded.length} 处`,
  );
});

test("安装使用 Add-AppxPackage 且不做重打包", () => {
  assert.ok(source.includes("Add-AppxPackage"));
  assert.ok(source.includes("-ForceApplicationShutdown"));
  // 不能出现「自己改包」的信号
  assert.ok(!/makeappx|signtool|\.p7x/.test(source));
});

test("安装后会等待 Appx 真正注册完成", () => {
  assert.ok(source.includes("waitForRegistration"));
  assert.ok(source.includes("Get-AppxPackage"));
});

test("检测同时覆盖 Appx 与便携版，不会把便携版误判成未安装", () => {
  assert.ok(source.includes("'APPX|'"));
  assert.ok(source.includes("'PORTABLE|'"));
  // 便携版常见落点必须被探测
  assert.ok(source.includes("Programs\\\\Codex") || source.includes("Programs\\Codex"));
});

test("--help 不会触发下载或安装", () => {
  assert.ok(source.includes('"--help"') || source.includes("--help"));
  assert.ok(source.includes("process.exit(0)"));
});
