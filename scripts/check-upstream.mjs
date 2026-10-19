#!/usr/bin/env node
/**
 * 上游版本检查（本地运行，不依赖 GitHub Actions）。
 *
 *   npm run check-upstream          # 检查并报告
 *   node scripts/check-upstream.mjs --json   # 机器可读输出
 *
 * 它回答三个问题：
 *   1. 官方现在的 Codex 最新版是多少？
 *   2. 本机装的是哪个版本？
 *   3. 我们的 supportedCodexVersions 里有没有登记？（没登记 = 可能没验证过）
 *
 * 退出码：
 *   0 = 一切同步
 *   1 = 发现新版本 / 未登记版本（需要你人工验证汉化）
 *   2 = 检查本身失败（网络等原因）
 *
 * 注意：这个脚本只**报告**，不改任何文件。要更新 supportedCodexVersions，
 * 需要你在真机验证汉化正常后手动改 resources/release.json。
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const MANIFEST_URL = "https://codexapp.agentsmirror.com/latest/manifest";
const MIRROR_REPO = "https://github.com/Wangnov/codex-app-mirror";
const PKG = "OpenAI.Codex";

function readJson(relPath) {
  const full = path.join(projectRoot, relPath);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

/** 跟随重定向取 JSON；只允许 https。 */
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`无效地址: ${url}`));
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error(`只允许 https: ${url}`));
      return;
    }
    const req = https.request(
      parsed,
      {
        method: "GET",
        headers: { "User-Agent": "codex-zh-cn-upstream-check", Accept: "application/json" },
        timeout: 20_000,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) {
            reject(new Error("重定向次数过多"));
            return;
          }
          resolve(fetchJson(new URL(res.headers.location, parsed).toString(), redirects + 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("返回的不是合法 JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时（20 秒）")));
    req.on("error", reject);
    req.end();
  });
}

/** 读本机已安装的 Codex 版本（Appx 或便携版）。取不到返回 null。 */
function localCodexVersion() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p = Get-AppxPackage -Name '${PKG}';`,
    "if ($p) { [Console]::Out.WriteLine($p.Version); exit 0 }",
    // 便携版：从 app 目录下的 manifest 里取版本
    "$h = Join-Path $env:LOCALAPPDATA 'Programs\\Codex';",
    "if (Test-Path $h) {",
    "  $m = Join-Path $h 'AppxManifest.xml';",
    "  if (Test-Path $m) {",
    "    $x = [xml](Get-Content $m -Raw);",
    "    $v = $x.Package.Identity.Version;",
    "    if ($v) { [Console]::Out.WriteLine($v) }",
    "  }",
    "}",
  ].join(" ");
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 45_000,
    });
    const out = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    return out[0] || null;
  } catch {
    return null;
  }
}

function compareVersion(a, b) {
  const pa = String(a).split(".").map((n) => Number(n) || 0);
  const pb = String(b).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function main() {
  const json = process.argv.includes("--json");
  const release = readJson("resources/release.json");
  const supported = Array.isArray(release.supportedCodexVersions)
    ? release.supportedCodexVersions
    : [];

  let latest = null;
  let manifestError = null;
  try {
    const manifest = await fetchJson(MANIFEST_URL);
    const win = manifest?.sources?.windows;
    latest = win?.architectures?.x64?.version || win?.version || null;
  } catch (error) {
    manifestError = error.message;
  }

  const local = localCodexVersion();

  const latestKnown = latest
    ? supported.some((v) => compareVersion(v, latest) === 0)
    : false;
  const localKnown = local
    ? supported.some((v) => compareVersion(v, local) === 0)
    : null;

  // 结论：是否需要人工验证
  const needsAttention =
    (latest !== null && !latestKnown) || (local !== null && localKnown === false);

  if (json) {
    console.log(
      JSON.stringify(
        {
          latestCodex: latest,
          localCodex: local,
          toolRelease: release.release,
          supportedCount: supported.length,
          latestKnown,
          localKnown,
          needsAttention,
          manifestError,
          mirror: MIRROR_REPO,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("");
    console.log("=== Codex 汉化 · 上游版本检查 ===");
    console.log("");
    console.log(`  工具版本        ${release.release}`);
    console.log(`  已登记适配      ${supported.length} 个 Codex 版本`);
    console.log("");
    if (manifestError) {
      console.log(`  [!] 无法读取官方清单：${manifestError}`);
      console.log(`      镜像仓库：${MIRROR_REPO}`);
    } else {
      console.log(`  官方最新版      ${latest || "未知"}`);
      console.log(
        `                  ${latestKnown ? "[已登记]" : "[未登记 —— 需要验证汉化]"} `,
      );
    }
    console.log(
      `  本机已安装      ${local || "未检测到"}${local && localKnown === false ? "  [未登记]" : ""}`,
    );
    console.log("");

    if (needsAttention) {
      console.log("  结论：可能有新版 Codex 未被验证。");
      console.log("        建议在真机上跑一次汉化，确认菜单结构仍然匹配，");
      console.log("        没问题再把版本号加进 resources/release.json 的");
      console.log("        supportedCodexVersions。");
    } else if (!manifestError) {
      console.log("  结论：与已登记版本一致，无需处理。");
    }
    console.log("");
  }

  if (manifestError && latest === null) process.exitCode = 2;
  else process.exitCode = needsAttention ? 1 : 0;
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(2);
});
