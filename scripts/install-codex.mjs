#!/usr/bin/env node
/**
 * 下载并安装官方 Codex Desktop（Windows）。
 *
 * 用法：
 *   node scripts/install-codex.mjs                  # 下载 + 校验 + 安装 + 验证
 *   node scripts/install-codex.mjs --check          # 只看当前装了什么
 *   node scripts/install-codex.mjs --no-install     # 只下载并校验，不安装
 *   node scripts/install-codex.mjs --msix <路径>    # 跳过下载，用本地 MSIX
 *   node scripts/install-codex.mjs --keep           # 保留下载的 MSIX
 *
 * 安装包来源（重要）：
 *   · 本脚本**不托管安装包**，也不重打包、不修改包内容。
 *   · 默认下载源是开源镜像站 codexapp.agentsmirror.com，由
 *     Wangnov/codex-app-mirror（MIT）维护：https://github.com/Wangnov/codex-app-mirror
 *     它每 15 分钟探测官方更新、原样镜像 Microsoft Store 分发的官方 MSIX、
 *     并提供 SHA256 供校验。感谢该项目，国内网络因此可以直连下载。
 *   · 镜像只做搬运，签名仍由 Microsoft 校验；`Add-AppxPackage` 安装时会验证包签名，
 *     被篡改的包无法安装成功。
 *   · 如需更换来源，改下面的 MANIFEST_URL 与 downloadUrl 即可，其余逻辑不变。
 *
 * 其他说明：
 *   · 安装走 `Add-AppxPackage`，需要提权（脚本会提示，而不是自己提权）。
 *   · 装完只做一件事：确认 Appx 包真的注册成功，版本与清单一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 安装包镜像源：由 Wangnov/codex-app-mirror（MIT）维护的开源镜像。
// 它原样镜像 Microsoft Store 分发的官方 MSIX，并提供清单与 SHA256 校验。
// 仓库：https://github.com/Wangnov/codex-app-mirror
// 换源只需改这两个常量，其余逻辑（校验 / 安装 / 验证）完全不变。
const MIRROR_ORIGIN = "https://codexapp.agentsmirror.com";
const MANIFEST_URL = `${MIRROR_ORIGIN}/latest/manifest`;
/** 镜像项目的公开仓库地址，用于日志与 README 溯源。 */
const MIRROR_REPO = "https://github.com/Wangnov/codex-app-mirror";
const PKG = "OpenAI.Codex";
const PKG_FAMILY_PREFIX = "OpenAI.Codex_";
const MAX_REDIRECTS = 6;
const CHUNK_TIMEOUT_MS = 60_000;

// ── 小工具 ────────────────────────────────────────────────────────────────

function log(message) {
  console.log(message);
}
function ok(message) {
  console.log(`[ok] ${message}`);
}
function info(message) {
  console.log(`[info] ${message}`);
}
function warn(message) {
  console.log(`[warn] ${message}`);
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function progressBar(done, total) {
  const width = 28;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const filled = Math.round((pct / 100) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return `[${bar}] ${String(pct).padStart(3)}% ${humanSize(done)}${
    total > 0 ? ` / ${humanSize(total)}` : ""
  }`;
}

// ── 参数 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    action: "install",
    msix: null,
    keep: false,
    arch: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check" || arg === "check") options.action = "check";
    else if (arg === "--no-install") options.action = "download";
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--msix") options.msix = argv[++i] || null;
    else if (arg === "--arch") options.arch = argv[++i] || null;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "用法: node scripts/install-codex.mjs [选项]",
          "",
          "  --check          只检测当前 Codex 安装情况，不下载",
          "  --no-install     只下载并校验 MSIX，不安装",
          "  --msix <路径>    使用本地已有的 MSIX，跳过下载",
          "  --arch <x64|arm64>  强制指定架构（默认自动判断）",
          "  --keep           安装后保留下载的 MSIX",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

// ── 架构 ──────────────────────────────────────────────────────────────────

function detectArch() {
  const arch = (process.env.PROCESSOR_ARCHITECTURE || "").toUpperCase();
  const wow = (process.env.PROCESSOR_ARCHITEW6432 || "").toUpperCase();
  if (arch === "ARM64" || wow === "ARM64") return "arm64";
  return "x64";
}

// ── HTTP ──────────────────────────────────────────────────────────────────

/** 跟随重定向拿最终响应；只允许 https（首次允许 https → 其它域的 https 跳转）。 */
function request(url, { method = "GET", redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`无效的下载地址: ${url}`));
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error(`只允许 https 下载地址，收到: ${url}`));
      return;
    }
    const transport = https;
    const req = transport.request(
      parsed,
      {
        method,
        headers: {
          "User-Agent": "codex-zh-cn-installer",
          Accept: "*/*",
        },
        timeout: CHUNK_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error(`重定向次数过多（>${MAX_REDIRECTS}）: ${url}`));
            return;
          }
          const next = new URL(res.headers.location, parsed).toString();
          resolve(request(next, { method, redirects: redirects + 1 }));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`下载失败 HTTP ${status}: ${url}`));
          return;
        }
        resolve({ res, finalUrl: parsed.toString() });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("下载超时（60 秒无数据）"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchJson(url) {
  const { res } = await request(url);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`清单不是合法 JSON: ${url}`);
  }
}

/** 解析清单里与当前架构相关的字段；缺失时返回 null，由调用方决定是否兜底。 */
export function readManifestInfo(manifest, arch) {
  const win = manifest?.sources?.windows;
  if (!win) return null;
  const entry = win.architectures?.[arch];
  if (!entry) return null;
  return {
    version: entry.version || win.version || null,
    packageMoniker: entry.packageMoniker || win.packageMoniker || null,
    contentLength: Number(entry.contentLength || win.contentLength || 0),
    downloadable: entry.downloadable !== false,
  };
}

// ── 下载 ──────────────────────────────────────────────────────────────────

async function downloadMsix(label, destPath) {
  const url = label.downloadUrl;
  info(`下载 Codex 安装包（${label.arch}）`);
  info(`来源: ${url}`);

  const { res, finalUrl } = await request(url);
  const total = Number(res.headers["content-length"]) || label.contentLength || 0;
  if (finalUrl !== url) info(`重定向到: ${finalUrl}`);

  const tmp = `${destPath}.part`;
  const handle = fs.createWriteStream(tmp);
  const hash = crypto.createHash("sha256");
  let done = 0;
  let lastTick = 0;

  try {
    for await (const chunk of res) {
      hash.update(chunk);
      if (!handle.write(chunk)) {
        await new Promise((r) => handle.once("drain", r));
      }
      done += chunk.length;
      const now = Date.now();
      if (now - lastTick > 800) {
        lastTick = now;
        process.stdout.write(`\r${progressBar(done, total)}`);
      }
    }
  } finally {
    await new Promise((r) => handle.end(r));
  }
  process.stdout.write("\r" + " ".repeat(72) + "\r");

  if (total > 0 && done !== total) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`下载不完整：期望 ${total} 字节，实际 ${done} 字节`);
  }

  fs.renameSync(tmp, destPath);
  const sha256 = hash.digest("hex");
  ok(`已下载 ${humanSize(done)}`);
  ok(`SHA-256 ${sha256}`);
  return { sha256, size: done };
}

// ── 当前安装状态 ──────────────────────────────────────────────────────────

/**
 * 读取当前用户已注册的 Codex 包（含系统范围预配）。
 *
 * ⚠️ 只查 `Get-AppxPackage` 是不够的：便携版 / 解压版**没有 Appx 身份**，
 * 但它才是很多人实际在用的形态。这里两条都查，分别报告，避免把
 * 「便携版已装」误判成「什么都没装」而让人白下一遍 900 MB。
 */
function queryInstalled() {
  // 不用 `$homes = @(a, b, c)` 这种拼数组的写法：十几行拼下来一个多余逗号
  // （PowerShell 的末端逗号是语法错误）就会让整段脚本静默失败，而且很难查。
  // 这里改成逐个 `Test-Portable <path>`，每行独立，错一行不影响其它行。
  const portableCandidates = [
    "$env:LOCALAPPDATA + '\\Programs\\Codex'",
    "$env:LOCALAPPDATA + '\\Programs\\codex'",
    "$env:LOCALAPPDATA + '\\Codex'",
    "$env:LOCALAPPDATA + '\\CodexZhCN\\app'",
    "$env:ProgramFiles + '\\Codex'",
    "$env:LOCALAPPDATA + '\\FMKJ\\CodexZhCN\\app'",
  ];
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p = Get-AppxPackage -Name '${PKG}';`,
    "if ($p) {",
    "  $p | ForEach-Object {",
    "    $loc = $_.InstallLocation;",
    "    $asar = Join-Path $loc 'app\\resources\\app.asar';",
    "    $parts = @($_.PackageFullName, $_.Version, $loc, [string](Test-Path -LiteralPath $asar)) -join '|';",
    "    [Console]::Out.WriteLine('APPX|' + $parts)",
    "  }",
    "}",
    ...portableCandidates.map(
      (expr) =>
        `$h = ${expr}; if ($h) { $a = Join-Path $h 'resources\\app.asar'; ` +
        `if (Test-Path -LiteralPath $a) { [Console]::Out.WriteLine('PORTABLE|' + $h + '||' + $h + '|true') } }`,
    ),
  ].join(" ");
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = (r.stdout || "").trim();
  if (!out) return null;
  const rows = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [kind, fullName, version, location, asar] = line.split("|");
      return {
        kind,
        fullName,
        version: version || null,
        location,
        asHasAsar: String(asar).toLowerCase() === "true",
      };
    });
  // Appx 版优先（它才是 install-codex 的目标），否则退到便携版。
  return (
    rows.find((row) => row.kind === "APPX" && row.asHasAsar) ||
    rows.find((row) => row.kind === "APPX") ||
    rows.find((row) => row.kind === "PORTABLE") ||
    null
  );
}

function checkState() {
  const installed = queryInstalled();
  if (!installed) {
    log("[env] codexInstalled=false");
    log("[env] codexKind=none");
    return { installed: false };
  }
  log("[env] codexInstalled=true");
  log(`[env] codexKind=${installed.kind}`);
  if (installed.fullName) log(`[env] codexFullName=${installed.fullName}`);
  if (installed.version) log(`[env] codexVersion=${installed.version}`);
  log(`[env] codexLocation=${installed.location}`);
  log(`[env] codexAsarPresent=${installed.asHasAsar}`);
  return { installed: true, ...installed };
}

// ── 安装 ──────────────────────────────────────────────────────────────────

function installMsix(msixPath) {
  const escaped = msixPath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop';",
    "try {",
    `  Add-AppxPackage -Path '${escaped}' -ForceApplicationShutdown -ErrorAction Stop;`,
    "  [Console]::Out.WriteLine('0|ok')",
    "} catch {",
    "  $code = 0;",
    "  try { $code = [int]$_.Exception.HResult } catch {}",
    "  [Console]::Out.WriteLine(([string]$code) + '|' + [string]$_.Exception.Message)",
    "}",
  ].join(" ");
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30 * 60_000,
  });
  const out = (r.stdout || "").trim();
  const lastLine = out.split(/\r?\n/).reverse().find((line) => line.includes("|"));
  if (!lastLine) {
    throw new Error(
      `Windows 安装进程没有返回结果。${
        (r.stderr || "").trim().slice(0, 300) || "可能被组策略拦截"
      }`,
    );
  }
  const [code, message] = lastLine.split("|");
  if (code.trim() === "0") return;
  const hex = Number(code) >>> 0;
  throw new Error(
    `${message.trim()} (HRESULT=0x${hex.toString(16).padStart(8, "0")})`,
  );
}

/** Windows 说装好了不等于真的就位：等 Appx 注册结果稳定下来再算成功。 */
function waitForRegistration(expectedVersion) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = queryInstalled();
    if (state && (!expectedVersion || state.version === expectedVersion)) {
      return state;
    }
    if (state && !expectedVersion) return state;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error(
    `Windows 尚未注册 Codex ${expectedVersion || ""}，请重启 Windows 后重试`,
  );
}

// ── 主流程 ────────────────────────────────────────────────────────────────

export async function main(argv) {
  const options = parseArgs(argv);

  if (options.action === "check") {
    const state = checkState();
    process.exitCode = state.installed ? 0 : 1;
    return;
  }

  const arch = options.arch || detectArch();
  log(`[env] arch=${arch}`);
  log(`[env] node=${process.version}`);

  const before = queryInstalled();
  if (before?.kind === "PORTABLE") {
    ok(`检测到便携版 Codex: ${before.location}`);
    info("便携版不需要安装，直接返回。请继续运行汉化（install-windows.bat 选 [1]）。");
    return;
  }
  if (before?.kind === "APPX") {
    info(`已安装 Codex ${before.version}（${before.location}）`);
    info("继续安装会用官方安装包覆盖/更新为清单中的版本。");
  } else {
    info("当前未检测到 Codex，开始安装。");
  }

  let msixPath = options.msix;
  let info_ = null;

  if (!msixPath) {
    let manifest = null;
    try {
      manifest = await fetchJson(MANIFEST_URL);
      info_ = readManifestInfo(manifest, arch);
      if (info_) {
        info(`清单版本 ${info_.version || "未知"}（${info_.packageMoniker || arch}）`);
        if (info_.contentLength) info(`包大小约 ${humanSize(info_.contentLength)}`);
        if (!info_.downloadable) {
          warn("清单标记该架构当前不可下载，仍会尝试直接下载。");
        }
      }
    } catch (error) {
      warn(`读取清单失败（不影响下载）: ${error.message}`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msix-"));
    msixPath = path.join(dir, `OpenAI.Codex-${arch}.msix`);
    info(`安装包来源：开源镜像 ${MIRROR_REPO}（MIT）`);
    await downloadMsix(
      {
        arch,
        downloadUrl: `${MIRROR_ORIGIN}/latest/win-${arch}`,
        contentLength: info_?.contentLength || 0,
      },
      msixPath,
    );
  } else {
    if (!fs.existsSync(msixPath)) {
      throw new Error(`找不到 MSIX: ${msixPath}`);
    }
    const size = fs.statSync(msixPath).size;
    const sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(msixPath))
      .digest("hex");
    ok(`使用本地 MSIX ${humanSize(size)}`);
    ok(`SHA-256 ${sha256}`);
  }

  if (options.action === "download") {
    const target = path.join(process.cwd(), path.basename(msixPath));
    fs.copyFileSync(msixPath, target);
    ok(`已保存到 ${target}`);
    return;
  }

  info("正在安装（可能需要几分钟，请勿关闭窗口）…");
  installMsix(msixPath);
  const after = waitForRegistration(info_?.version || null);
  ok(`Codex ${after.version} 已就位: ${after.location}`);
  if (!after.asHasAsar) {
    warn("未在该安装目录找到 app\\resources\\app.asar，汉化可能无法进行。");
  }

  if (!options.keep) {
    try {
      fs.rmSync(path.dirname(msixPath), { recursive: true, force: true });
    } catch {}
  }
}

const isEntry = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isEntry) {
  main(process.argv).catch((error) => {
    console.error(`[error] ${error.message}`);
    process.exit(1);
  });
}
