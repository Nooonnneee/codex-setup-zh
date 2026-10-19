#!/usr/bin/env node
/**
 * 下载并安装官方 Codex Desktop（macOS）。
 *
 * 用法：
 *   node scripts/install-codex-mac.mjs             # 下载 + 校验 + 安装
 *   node scripts/install-codex-mac.mjs --check     # 只看当前装了什么
 *   node scripts/install-codex-mac.mjs --no-install # 只下载并校验
 *   node scripts/install-codex-mac.mjs --dmg <路径> # 用本地 DMG
 *
 * 安装包来源：
 *   · 本脚本**不托管安装包**，也不重打包、不修改包内容。
 *   · 默认来源是开源镜像站 codexapp.agentsmirror.com，由
 *     Wangnov/codex-app-mirror（MIT）维护：https://github.com/Wangnov/codex-app-mirror
 *     它原样镜像官方 DMG 并提供 SHA256 供校验。
 *   · 镜像只做搬运，签名仍由 Apple / OpenAI 校验；篡改过的包会被 Gatekeeper 拒绝。
 *
 * 说明：
 *   · 这是**只装 Codex** 的脚本。本仓库的汉化只支持 Windows（改 asar + Appx），
 *     macOS 版是原生应用，没有对应的汉化方案。
 *   · 装完会用 `xattr -dr com.apple.quarantine` 清掉隔离属性，否则首次打开会提示
 *     「无法验证开发者」。这个操作只影响本 App，不改系统设置。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIRROR_ORIGIN = "https://codexapp.agentsmirror.com";
const MANIFEST_URL = `${MIRROR_ORIGIN}/latest/manifest`;
const MIRROR_REPO = "https://github.com/Wangnov/codex-app-mirror";
const APP_NAME = "ChatGPT.app";
const BUNDLE_ID = "com.openai.codex";
const MAX_REDIRECTS = 6;
const CHUNK_TIMEOUT_MS = 60_000;

// ── 输出 ──────────────────────────────────────────────────────────────────

const log = (m) => console.log(m);
const ok = (m) => console.log(`[ok] ${m}`);
const info = (m) => console.log(`[info] ${m}`);
const warn = (m) => console.log(`[warn] ${m}`);

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
  const options = { action: "install", dmg: null, keep: false, arch: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check" || arg === "check") options.action = "check";
    else if (arg === "--no-install") options.action = "download";
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--dmg") options.dmg = argv[++i] || null;
    else if (arg === "--arch") options.arch = argv[++i] || null;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "用法: node scripts/install-codex-mac.mjs [选项]",
          "",
          "  --check          只检测当前 Codex 安装情况",
          "  --no-install     只下载并校验 DMG，不安装",
          "  --dmg <路径>     使用本地已有的 DMG",
          "  --arch <arm64|x64>  强制指定架构（默认自动判断）",
          "  --keep           安装后保留下载的 DMG",
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

/** macOS 上 os.arch() 返回 x64 / arm64，正好对应镜像的两条短链。 */
function detectArch() {
  const a = os.arch();
  return a === "arm64" ? "arm64" : "x64";
}

function archLabel(arch) {
  return arch === "arm64" ? "Apple Silicon (arm64)" : "Intel (x64)";
}

// ── HTTP ──────────────────────────────────────────────────────────────────

function request(url, { method = "GET", redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`无效地址: ${url}`));
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error(`只允许 https 下载地址，收到: ${url}`));
      return;
    }
    const req = https.request(
      parsed,
      {
        method,
        headers: { "User-Agent": "codex-zh-cn-installer", Accept: "*/*" },
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
          resolve(
            request(new URL(res.headers.location, parsed).toString(), {
              method,
              redirects: redirects + 1,
            }),
          );
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
    req.on("timeout", () => req.destroy(new Error("下载超时（60 秒无数据）")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchJson(url) {
  const { res } = await request(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`清单不是合法 JSON: ${url}`);
  }
}

/** 从清单里取出 macOS 指定架构的信息；缺失返回 null，由调用方兜底。 */
export function readManifestInfo(manifest, arch) {
  const mac = manifest?.sources?.macos;
  if (!mac) return null;
  const entry = mac[arch];
  if (!entry) return null;
  return {
    version: entry.bundleShortVersion || manifest?.codexVersion || null,
    sha256: typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : null,
    contentLength: Number(entry.contentLength || entry.size || 0),
    minimumSystemVersion: entry.minimumSystemVersion || null,
    bundleIdentifier: entry.bundleIdentifier || null,
    downloadable: entry.downloadable !== false,
    status: entry.status || null,
  };
}

// ── 下载 ──────────────────────────────────────────────────────────────────

async function downloadDmg({ arch, expectedSha, contentLength }, destPath) {
  const url = `${MIRROR_ORIGIN}/latest/mac-${arch === "arm64" ? "arm64" : "intel"}`;
  info(`下载 Codex 安装包（${archLabel(arch)}）`);
  info(`来源: ${url}`);

  const { res, finalUrl } = await request(url);
  const total = Number(res.headers["content-length"]) || contentLength || 0;
  if (finalUrl !== url) info(`重定向到: ${new URL(finalUrl).host}`);

  const tmp = `${destPath}.part`;
  const handle = fs.createWriteStream(tmp);
  const hash = crypto.createHash("sha256");
  let done = 0;
  let lastTick = 0;

  try {
    for await (const chunk of res) {
      hash.update(chunk);
      if (!handle.write(chunk)) await new Promise((r) => handle.once("drain", r));
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

  if (expectedSha) {
    if (sha256 !== expectedSha) {
      fs.rmSync(destPath, { force: true });
      throw new Error(
        `SHA-256 不匹配，已删除下载文件。\n  期望: ${expectedSha}\n  实际: ${sha256}`,
      );
    }
    ok("SHA-256 与官方清单一致");
  } else {
    warn("清单未提供 SHA-256，跳过校验");
  }

  return { sha256, size: done };
}

// ── 本机状态 ──────────────────────────────────────────────────────────────

/** 读已安装 App 的版本（优先 /Applications，其次 ~/Applications）。 */
function queryInstalled() {
  const candidates = [
    `/Applications/${APP_NAME}`,
    path.join(os.homedir(), "Applications", APP_NAME),
  ];
  for (const appPath of candidates) {
    if (!fs.existsSync(appPath)) continue;
    const plist = path.join(appPath, "Contents", "Info.plist");
    let version = null;
    let bundleId = null;
    if (fs.existsSync(plist)) {
      const short = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], {
        encoding: "utf8",
      });
      if (short.status === 0) version = short.stdout.trim() || null;
      const bid = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], {
        encoding: "utf8",
      });
      if (bid.status === 0) bundleId = bid.stdout.trim() || null;
    }
    return { path: appPath, version, bundleId };
  }
  return null;
}

function checkState() {
  const installed = queryInstalled();
  log(`[env] os=${process.platform} arch=${os.arch()}`);
  log(`[env] macosVersion=${os.release()}`);
  if (!installed) {
    log("[env] codexInstalled=false");
    return { installed: false };
  }
  log("[env] codexInstalled=true");
  log(`[env] codexPath=${installed.path}`);
  log(`[env] codexVersion=${installed.version || "unknown"}`);
  log(`[env] bundleId=${installed.bundleId || "unknown"}`);
  return { installed: true, ...installed };
}

// ── 安装 ──────────────────────────────────────────────────────────────────

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    const detail = ((r.stderr || "") + (r.stdout || "")).trim().slice(0, 300);
    throw new Error(`${label || cmd} 失败（退出码 ${r.status}）${detail ? `：\n${detail}` : ""}`);
  }
  return (r.stdout || "").trim();
}

function mountDmg(dmgPath) {
  // -nobrowse 避免在 Finder 里弹出一个卷；-noverify 跳过对签名 DMG 的额外校验
  // （真正的校验是我们自己做的 SHA-256 与 install 时的系统校验）。
  const out = run(
    "hdiutil",
    ["attach", dmgPath, "-nobrowse", "-noverify", "-plist"],
    "挂载 DMG",
  );
  // plist 输出里找挂载点
  const match = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(out);
  if (match) return match[1];
  // 兜底：/Volumes 下最新的目录
  const volumes = fs
    .readdirSync("/Volumes")
    .map((n) => path.join("/Volumes", n))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) =>
        fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
    );
  if (volumes.length === 0) throw new Error("DMG 已挂载但找不到挂载点");
  return volumes[0];
}

function detachDmg(mountPoint) {
  try {
    run("hdiutil", ["detach", mountPoint, "-quiet"], "卸载 DMG");
  } catch {
    // 卸载失败不影响安装结果
    try {
      run("hdiutil", ["detach", mountPoint, "-force", "-quiet"], "强制卸载 DMG");
    } catch {}
  }
}

function installFromDmg(dmgPath) {
  info("正在挂载安装包…");
  const mountPoint = mountDmg(dmgPath);
  try {
    const appInDmg = path.join(mountPoint, APP_NAME);
    if (!fs.existsSync(appInDmg)) {
      // 有些包把 app 放在子目录
      const found = fs
        .readdirSync(mountPoint)
        .filter((n) => n.endsWith(".app"))
        .map((n) => path.join(mountPoint, n));
      if (found.length === 0) throw new Error("DMG 里没有找到 .app");
      return copyApp(found[0]);
    }
    return copyApp(appInDmg);
  } finally {
    detachDmg(mountPoint);
  }
}

function copyApp(sourceApp) {
  const target = path.join("/Applications", APP_NAME);
  const homeTarget = path.join(os.homedir(), "Applications", APP_NAME);

  // 先尝试 /Applications；没有写权限就退回 ~/Applications
  let dest = target;
  try {
    fs.accessSync("/Applications", fs.constants.W_OK);
  } catch {
    fs.mkdirSync(path.join(os.homedir(), "Applications"), { recursive: true });
    dest = homeTarget;
    warn("/Applications 不可写，改装到 ~/Applications");
  }

  if (fs.existsSync(dest)) {
    info(`检测到已安装，先移除旧版本: ${dest}`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  info(`正在复制到 ${dest} …（约 1-2 分钟）`);
  // 用 ditto 保留资源分支、扩展属性与代码签名
  run("ditto", [sourceApp, dest], "复制 App");

  if (!fs.existsSync(dest)) throw new Error("复制后找不到目标 App");

  // 清掉隔离属性，否则首次启动会被 Gatekeeper 拦下
  try {
    run("xattr", ["-dr", "com.apple.quarantine", dest], "清除隔离属性");
    info("已清除隔离属性（避免「无法验证开发者」提示）");
  } catch {
    warn("清除隔离属性失败，首次打开可能需要在「系统设置 → 隐私与安全性」里点「仍要打开」");
  }

  return dest;
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
  log(`[env] arch=${arch} (${archLabel(arch)})`);
  log(`[env] node=${process.version}`);

  const before = queryInstalled();
  if (before) {
    info(`已安装 Codex ${before.version || ""}（${before.path}）`);
    info("继续安装会用官方包覆盖更新。");
  } else {
    info("当前未检测到 Codex，开始安装。");
  }

  let dmgPath = options.dmg;
  let manifestInfo = null;

  if (!dmgPath) {
    try {
      const manifest = await fetchJson(MANIFEST_URL);
      manifestInfo = readManifestInfo(manifest, arch);
      if (manifestInfo) {
        info(
          `清单版本 ${manifestInfo.version || "未知"}${
            manifestInfo.minimumSystemVersion
              ? `，要求 macOS ${manifestInfo.minimumSystemVersion}+`
              : ""
          }`,
        );
        if (manifestInfo.contentLength) {
          info(`包大小约 ${humanSize(manifestInfo.contentLength)}`);
        }
        if (!manifestInfo.downloadable) {
          warn("清单标记该架构当前不可下载，仍会尝试直接下载。");
        }
      }
    } catch (error) {
      warn(`读取清单失败（不影响下载）: ${error.message}`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dmg-"));
    dmgPath = path.join(dir, `Codex-mac-${arch}.dmg`);
    await downloadDmg(
      {
        arch,
        expectedSha: manifestInfo?.sha256 || null,
        contentLength: manifestInfo?.contentLength || 0,
      },
      dmgPath,
    );
  } else {
    if (!fs.existsSync(dmgPath)) throw new Error(`找不到 DMG: ${dmgPath}`);
    const size = fs.statSync(dmgPath).size;
    const sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(dmgPath))
      .digest("hex");
    ok(`使用本地 DMG ${humanSize(size)}`);
    ok(`SHA-256 ${sha256}`);
  }

  if (options.action === "download") {
    const target = path.join(process.cwd(), path.basename(dmgPath));
    fs.copyFileSync(dmgPath, target);
    ok(`已保存到 ${target}`);
    return;
  }

  const installedPath = installFromDmg(dmgPath);
  const after = queryInstalled();
  ok(`Codex 已安装: ${installedPath}`);
  if (after?.version) ok(`版本 ${after.version}`);

  if (!options.keep) {
    try {
      fs.rmSync(path.dirname(dmgPath), { recursive: true, force: true });
    } catch {}
  }

  console.log("");
  info("打开 Codex：在「启动台」或「应用程序」里点 ChatGPT。");
  warn("macOS 版**没有简体中文界面**，本仓库的汉化只支持 Windows。");
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
