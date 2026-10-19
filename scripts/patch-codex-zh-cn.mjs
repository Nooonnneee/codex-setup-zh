#!/usr/bin/env node
/**
 * Patch Codex Desktop for Simplified Chinese (zh-CN).
 * Usage:
 *   node scripts/patch-codex-zh-cn.mjs install [--codex-path PATH]
 *   node scripts/patch-codex-zh-cn.mjs uninstall [--codex-path PATH]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { buildLocalizationDiagnostic } from "./localization-diagnostics.mjs";
import { readAsarEntries } from "./asar-reader.mjs";
import {
  hasRuntimeBootstrap,
  resolveRuntimeDir,
  resolveRuntimeStatusPath,
} from "./localization-runtime.mjs";
import {
  MANAGED_PORTABLE_MARKER,
  applyUpdatePromptPatches,
  buildInPlaceMarker,
  decideLocalizationTargetKind,
  hasOfficialI18nGatePatch,
  injectRuntimeBootstrapSource,
  isFirewallRegistrationFailure,
  patchOfficialI18nGateSource,
  resolveInPlaceMarkerVersion,
  stripFirewallRulesExtensions,
} from "./localization-patches.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const resourcesDir = path.join(projectRoot, "resources");
/** 本工具自带的语言包运行时目录（`runtime/main.cjs` 所在处）。 */
const RUNTIME_DIR = resolveRuntimeDir(projectRoot);
const ASAR_BLOCK_SIZE = 4 * 1024 * 1024;
const INSTALL_STEP_TOTAL = 8;
const localizationDiagnostic = { step: "preflight", installKind: "unknown", packageIdentity: "unknown", rollback: "not_attempted" };

// ── 「汉化副本 + 松散注册」路线的固定参数 ─────────────────────────────────
// 2026-09-20 真机端到端实测通过（见 TRAPS.md「路线 A」）：
//   复制商店版整包到用户目录 → 改 AppxManifest 的 Identity / 沙箱服务名 / 显示名
//   → 提权 `Add-AppxPackage -Register` 松散注册 → 副本从此是**有包身份的正经应用**。
// 为什么不再原地改写商店包：Win11 24H2 从系统层面封死了 `WindowsApps` 写盘，
// 提权也一样失败（三条独立证据见 TRAPS.md）。
/** 副本整包的落点。注册后它就是该包的 InstallLocation。 */
const REGISTERED_COPY_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "CodexZhCN",
  "app",
);
/** 副本包名。加 `.FMKJ` 后缀才能与商店版 `OpenAI.Codex` 共存而不冲突。
 *  该后缀是包身份的一部分，改动会让已装用户的副本变成另一个包，故保持不变。 */
const REGISTERED_PACKAGE_NAME = "OpenAI.Codex.FMKJ";
/** 包内沙箱服务名必须唯一，否则注册报 `0x80073CF6` → 内层 `0x80073D26`。 */
const REGISTERED_SERVICE_NAME = "CodexSandboxService.OpenAI.Codex.FMKJ";
const REGISTERED_DISPLAY_NAME = "ChatGPT 汉化版";
/**
 * 复制时必须剔掉的文件：原包的签名与块映射对新包名不再有效，
 * 留着会让 `-Register` 直接失败。实测必须排除这三项。
 */
const APPX_COPY_EXCLUDES = [
  "AppxSignature.p7x",
  "AppxBlockMap.xml",
  "AppxMetadata",
  "microsoft.system.package.metadata",
];

/**
 * 清单手术（删掉 `windows.firewallRules` 声明、以及「没多删无关扩展」的复核）已下沉到
 * `localization-patches.mjs` 的 `stripFirewallRulesExtensions` —— 它是纯函数、有单测覆盖。
 * 本文件只负责调用与写回。**自闭合形式怎么匹配、为什么不能跨标签吞并**，
 * 见该函数上方的注释。
 *
 * ⚠️ 2026-09-21 起这条手术改成**条件删**：`patchRegisteredManifest` 不再预先删声明，
 * 健康机器因此保住几条入站端口预授权；只有 `registerAppxCopy()` 真收到防火墙类拒绝
 * （`0x800706D9`，判据 `isFirewallRegistrationFailure`）时，才删声明再注册一次。
 */

/** 实时输出进度（避免 PowerShell 管道缓冲时长时间无输出） */
function progressLog(step, total, message) {
  const line = `[step ${step}/${total}] ${message}`;
  console.log(line);
}

function logInfo(message) {
  console.log(`[info] ${message}`);
}

function logOk(message) {
  console.log(`[ok] ${message}`);
}

function formatProgressBar(current, total, label = "") {
  const pct =
    total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
  const short = label.length > 36 ? `…${label.slice(-35)}` : label;
  return `[${bar}] ${String(pct).padStart(3)}% (${current}/${total}) ${short}`.trimEnd();
}

function logProgressBar(current, total, label = "") {
  console.log(`[progress-bar] ${formatProgressBar(current, total, label)}`);
}

function runWithProgressHeartbeat(message, fn) {
  const started = Date.now();
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const sec = Math.round((Date.now() - started) / 1000);
    const spin = ["|", "/", "-", "\\"][tick % 4];
    console.log(
      `[progress-bar] [${"░".repeat(30)}] ${spin} ${message}（已等待 ${sec} 秒，请勿关闭）`,
    );
  }, 2000);
  try {
    return fn();
  } finally {
    clearInterval(timer);
  }
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256Range(data, offset, count) {
  return crypto
    .createHash("sha256")
    .update(data.subarray(offset, offset + count))
    .digest("hex");
}

function readU32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

function align4(value) {
  return value + ((4 - (value % 4)) % 4);
}

function readAsarHeader(data, asarPath) {
  if (data.length < 16)
    throw new Error(`Unsupported app.asar header in ${asarPath}`);
  const headerSize = readU32LE(data, 4);
  if (
    readU32LE(data, 0) !== 4 ||
    headerSize <= 0 ||
    data.length < 8 + headerSize
  ) {
    throw new Error(`Unsupported app.asar size pickle in ${asarPath}`);
  }
  const headerPickle = data.subarray(8, 8 + headerSize);
  const headerPayloadSize = readU32LE(headerPickle, 0);
  const headerStringSize = headerPickle.readInt32LE(4);
  const expectedPayloadSize = align4(4 + headerStringSize);
  if (
    headerPayloadSize !== expectedPayloadSize ||
    headerSize !== 4 + headerPayloadSize
  ) {
    throw new Error(`Unsupported app.asar header pickle in ${asarPath}`);
  }
  const headerString = headerPickle
    .subarray(8, 8 + headerStringSize)
    .toString("utf8");
  return {
    headerSize,
    headerString,
    header: JSON.parse(headerString),
  };
}

function encodeAsarHeaderDynamic(headerString) {
  const headerBytes = Buffer.from(headerString, "utf8");
  const headerPayloadSize = align4(4 + headerBytes.length);
  const headerPickleSize = 4 + headerPayloadSize;
  const headerPickle = Buffer.alloc(headerPickleSize);
  headerPickle.writeUInt32LE(headerPayloadSize, 0);
  headerPickle.writeInt32LE(headerBytes.length, 4);
  headerBytes.copy(headerPickle, 8);
  const encoded = Buffer.alloc(8 + headerPickleSize);
  encoded.writeUInt32LE(4, 0);
  encoded.writeUInt32LE(headerPickleSize, 4);
  headerPickle.copy(encoded, 8);
  return encoded;
}

function walkAsarFiles(node, prefix = "", results = []) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const next = prefix ? `${prefix}/${name}` : name;
      walkAsarFiles(child, next, results);
    }
  } else if ("offset" in node && "size" in node) {
    results.push([prefix, node]);
  }
  return results;
}

function getAsarFileEntry(header, filePath) {
  let node = header;
  for (const part of filePath.split("/")) {
    if (!node.files?.[part])
      throw new Error(`Could not find ${filePath} in app.asar header.`);
    node = node.files[part];
  }
  for (const key of ["size", "offset", "integrity"]) {
    if (!(key in node))
      throw new Error(`Missing ${key} for ${filePath} in app.asar header.`);
  }
  return node;
}

function getAsarFileIntegrity(data) {
  const blocks = [];
  if (data.length === 0) blocks.push(sha256(data));
  else {
    for (let offset = 0; offset < data.length; offset += ASAR_BLOCK_SIZE) {
      const count = Math.min(ASAR_BLOCK_SIZE, data.length - offset);
      blocks.push(sha256Range(data, offset, count));
    }
  }
  return {
    algorithm: "SHA256",
    hash: sha256(data),
    blockSize: ASAR_BLOCK_SIZE,
    blocks,
  };
}

function applyAsarBufferPatch(state, filePath, patchedContent) {
  const { data, parsed, label } = state;
  const headerSize = parsed.headerSize;
  const header = parsed.header;
  const entry = getAsarFileEntry(header, filePath);

  const contentOffset = 8 + headerSize + Number(entry.offset);
  const contentSize = Number(entry.size);
  const contentEnd = contentOffset + contentSize;
  if (contentOffset < 0 || contentEnd > data.length) {
    throw new Error(`Unsupported app.asar file bounds for ${filePath}.`);
  }

  const oldContent = data.subarray(contentOffset, contentEnd);
  if (oldContent.equals(patchedContent)) return false;

  const targetOffset = Number(entry.offset);
  const delta = patchedContent.length - contentSize;
  entry.size = patchedContent.length;
  entry.integrity = getAsarFileIntegrity(patchedContent);

  if (delta !== 0) {
    for (const [, other] of walkAsarFiles(header)) {
      if (other !== entry && Number(other.offset) > targetOffset) {
        other.offset = String(Number(other.offset) + delta);
      }
    }
  }

  const bodyStart = 8 + headerSize;
  const before = data.subarray(bodyStart, contentOffset);
  const after = data.subarray(contentEnd);
  const body = Buffer.concat([before, patchedContent, after]);

  const updatedHeaderString = JSON.stringify(header);
  const updatedHeader = encodeAsarHeaderDynamic(updatedHeaderString);
  const updated = Buffer.concat([updatedHeader, body]);
  state.data = updated;
  state.parsed = readAsarHeader(updated, label || "app.asar");
  return true;
}

function replaceAsarFileContent(asarPath, filePath, patchedContent) {
  const data = Buffer.from(fs.readFileSync(asarPath));
  const state = {
    data,
    parsed: readAsarHeader(data, asarPath),
    label: asarPath,
  };
  if (!applyAsarBufferPatch(state, filePath, patchedContent)) return false;
  writeInstallFile(asarPath, state.data);
  return true;
}

function replaceStandaloneAsarFile(asarPath, relativePath, contentBuffer) {
  return replaceAsarFileContent(asarPath, relativePath, contentBuffer);
}

function getAsarHeaderHash(asarPath) {
  const data = fs.readFileSync(asarPath);
  const parsed = readAsarHeader(data, asarPath);
  return sha256(Buffer.from(parsed.headerString, "utf8"));
}

const EXE_ASAR_INTEGRITY_MARKERS = [
  '{"file":"resources\\\\app.asar","alg":"SHA256","value":"',
  '{"file":"resources\\/app.asar","alg":"SHA256","value":"',
  '{"file":"resources/app.asar","alg":"SHA256","value":"',
];

/**
 * 可能内嵌 app.asar 完整性哈希的可执行文件。
 * 新版 Microsoft Store 版真正的 Electron 入口是 ChatGPT.exe；
 * Codex.exe / codex.exe 只是包激活存根，不含 Electron 资源，必须放在后面。
 * 注意：不能取「第一个存在的文件」就算数——存根也存在，但里面没有哈希字段。
 */
const CODEX_EXE_CANDIDATES = ["ChatGPT.exe", "Codex.exe", "codex.exe"];

function findExeAsarIntegrityOffset(exeText) {
  for (const marker of EXE_ASAR_INTEGRITY_MARKERS) {
    const markerIndex = exeText.indexOf(marker);
    if (markerIndex >= 0) {
      return { markerIndex, marker, hashOffset: markerIndex + marker.length };
    }
  }
  return null;
}

function syncExeAsarIntegrity(codexDir, asarPath) {
  const exePaths = CODEX_EXE_CANDIDATES.map((name) =>
    path.join(codexDir, name),
  ).filter((candidate) => fs.existsSync(candidate));
  if (exePaths.length === 0) {
    console.log(
      `[info] 未找到 ${CODEX_EXE_CANDIDATES.join(" / ")}，跳过完整性哈希同步。`,
    );
    return;
  }

  const headerHash = getAsarHeaderHash(asarPath);
  let markerFound = false;
  let updated = 0;

  // 逐个尝试：真正带 Electron 资源的那个（新版为 ChatGPT.exe）才有哈希字段。
  for (const exePath of exePaths) {
    const exeData = fs.readFileSync(exePath);
    const exeText = exeData.toString("latin1");
    const match = findExeAsarIntegrityOffset(exeText);
    if (!match) continue;
    markerFound = true;

    const { hashOffset } = match;
    const currentHash = exeText.slice(hashOffset, hashOffset + 64);
    if (currentHash === headerHash) {
      console.log(`[ok] ${path.basename(exePath)} 完整性哈希已是最新。`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(currentHash)) {
      console.warn(
        `[warn] ${path.basename(exePath)} 完整性字段异常，跳过哈希同步。`,
      );
      continue;
    }

    backupFile(exePath, getInstallBackupRoot(codexDir));

    const newHashBytes = Buffer.from(headerHash, "ascii");
    newHashBytes.copy(exeData, hashOffset);
    writeInstallFile(exePath, exeData);
    updated += 1;
    console.log(
      `[ok] 已更新 ${path.basename(exePath)} 完整性哈希: ${currentHash} -> ${headerHash}`,
    );
  }

  if (!markerFound) {
    console.log(
      "[info] 可执行文件中未嵌入 app.asar 完整性标记，跳过哈希同步（旧版 Codex 常见）。",
    );
    return;
  }
  if (updated === 0) {
    console.log("[ok] 全部可执行文件的完整性哈希均已是最新。");
  }
}

function resolveCodexInstallDir(dir) {
  if (!dir) return null;
  const directAsar = path.join(dir, "resources", "app.asar");
  if (fs.existsSync(directAsar)) {
    return { app: dir, resources: path.join(dir, "resources") };
  }
  const msixApp = path.join(dir, "app");
  const msixAsar = path.join(msixApp, "resources", "app.asar");
  if (fs.existsSync(msixAsar)) {
    return { app: msixApp, resources: path.join(msixApp, "resources") };
  }
  return null;
}

const SAVED_CODEX_PATH_FILE = path.join(
  os.homedir(),
  ".codex",
  "codex-desktop-path.txt",
);

function readSavedCodexPath() {
  try {
    const value = fs.readFileSync(SAVED_CODEX_PATH_FILE, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeSavedCodexPath(dir) {
  const resolved = resolveCodexInstallDir(dir);
  if (!resolved) {
    throw new Error(`无法保存无效 Codex 路径: ${dir}`);
  }
  fs.mkdirSync(path.dirname(SAVED_CODEX_PATH_FILE), { recursive: true });
  fs.writeFileSync(SAVED_CODEX_PATH_FILE, resolved.app, "utf8");
}

function clearSavedCodexPath() {
  try {
    fs.unlinkSync(SAVED_CODEX_PATH_FILE);
  } catch {}
}

function readEnvCodexPath() {
  for (const name of ["CODEX_DESKTOP_PATH", "CODEX_ZH_CN_PATH"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function findWindowsAppsCodex() {
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'OpenAI.Codex' -or $_.Name -eq 'OpenAI.Codex_customer-install' } | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)",
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    const installLocation = ps.stdout?.trim();
    if (installLocation) {
      const resolved = resolveCodexInstallDir(installLocation);
      if (resolved) return resolved;
    }
  } catch {}

  const windowsApps = path.join(
    process.env.ProgramFiles || "C:\\Program Files",
    "WindowsApps",
  );
  if (!fs.existsSync(windowsApps)) return null;

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(windowsApps, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          /^OpenAI\.Codex(?:_customer-install)?_\d/i.test(d.name),
      )
      .map((d) => path.join(windowsApps, d.name));
  } catch {
    return null;
  }

  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of dirs) {
    const resolved = resolveCodexInstallDir(dir);
    if (resolved) return resolved;
  }
  return null;
}

const CODEX_DIR_PATTERN = /^(Codex|OpenAI\.Codex)/i;

function findInParent(base, childPattern = CODEX_DIR_PATTERN) {
  if (!base || !fs.existsSync(base)) return null;
  const direct = resolveCodexInstallDir(base);
  if (direct) return direct;

  let entries = [];
  try {
    entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && childPattern.test(d.name))
      .map((d) => path.join(base, d.name));
  } catch {
    return null;
  }

  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of entries) {
    const resolved = resolveCodexInstallDir(dir);
    if (resolved) return resolved;
  }
  return null;
}

function findRegistryCodex() {
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        [
          "$keys = @(",
          "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
          ")",
          "$locations = foreach ($key in $keys) {",
          "  Get-ItemProperty $key -ErrorAction SilentlyContinue |",
          "    Where-Object {",
          "      $_.InstallLocation -and",
          "      ($_.DisplayName -eq 'Codex' -or $_.DisplayName -match '^Codex\\s') -and",
          "      $_.DisplayName -notmatch '\\+\\+|Helper'",
          "    } |",
          "    Select-Object -ExpandProperty InstallLocation",
          "}",
          "$locations | Select-Object -Unique",
        ].join(" "),
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    const lines = ps.stdout?.trim().split(/\r?\n/).filter(Boolean) || [];
    for (const loc of lines) {
      const resolved = resolveCodexInstallDir(loc.trim());
      if (resolved) return resolved;
    }
  } catch {}
  return null;
}

function getScanBases() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  const userProfile = os.homedir();

  const bases = [
    path.join(localAppData, "Programs", "Codex"),
    path.join(localAppData, "Programs"),
    path.join(localAppData, "Codex"),
    path.join(programFiles, "Codex"),
    programFilesX86 ? path.join(programFilesX86, "Codex") : "",
    path.join(userProfile, "Desktop"),
    path.join(userProfile, "Downloads"),
    "D:\\soft",
    "E:\\soft",
  ];

  const seen = new Set();
  return bases.filter((base) => {
    if (!base || seen.has(base)) return false;
    seen.add(base);
    return fs.existsSync(base);
  });
}

function findCodexInstall(explicitPath) {
  if (explicitPath) {
    const resolved = resolveCodexInstallDir(explicitPath);
    if (resolved) return resolved;
    throw new Error(
      `未在指定路径找到 resources/app.asar（支持便携版目录或 MSIX 包根目录）: ${explicitPath}`,
    );
  }

  for (const candidate of [readEnvCodexPath(), readSavedCodexPath()]) {
    if (!candidate) continue;
    const resolved = resolveCodexInstallDir(candidate);
    if (resolved) return resolved;
  }

  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Process Codex,codex -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    const procPath = ps.stdout?.trim();
    if (procPath) {
      let dir = path.dirname(procPath);
      for (let depth = 0; depth < 6 && dir; depth += 1) {
        const resolved = resolveCodexInstallDir(dir);
        if (resolved) return resolved;
        dir = path.dirname(dir);
      }
    }
  } catch {}

  const windowsAppsInstall = findWindowsAppsCodex();
  if (windowsAppsInstall) return windowsAppsInstall;

  const registryInstall = findRegistryCodex();
  if (registryInstall) return registryInstall;

  for (const base of getScanBases()) {
    const found = findInParent(base);
    if (found) return found;
  }

  throw new Error(
    "未找到 Codex Desktop 安装目录。请使用 --codex-path 指定，或设置环境变量 CODEX_DESKTOP_PATH。",
  );
}

/**
 * 「Codex 相关进程」的**路径**特征。检测与强制结束两处必须用同一份 ——
 * 加新形态时三处一起改（检测 / 按路径停 / 按名字停），漏一处就是死循环。
 *
 * 已知安装形态都必须覆盖：
 *   · 普通安装：`%LOCALAPPDATA%\Programs\Codex\ChatGPT.exe`
 *   · 官方 Store 包：`…\WindowsApps\OpenAI.Codex_…`
 *   · 现役汉化副本：`%LOCALAPPDATA%\CodexZhCN\app`（独立版；旧版在 `\FMKJ\CodexZhCN`）
 *   · 旧可写副本：`~/.codex/zh-cn-patched`（0.1.89 及更早）
 *
 * 🔴 2026-09-20 实测踩过「漏掉现役副本」的后果：副本的 ChatGPT.exe 在跑却检测不到、
 * 关不掉，而它又会不断把自己的 `codex.exe` 子进程拉起来 ⇒
 * 「杀掉 codex.exe → 它又回来了」死循环，汉化卡在第 1 步「无法关闭 Codex」。
 */
const CODEX_PS_PATH_MATCH =
  "OpenAI\\\\Codex|zh-cn-patched|WindowsApps\\\\OpenAI\\.Codex_|CodexHelper|codex-helper|CodexZhCN|\\\\Programs\\\\Codex\\\\";

const CODEX_PS_DETECT = [
  "$ErrorActionPreference = 'Stop'",
  "$names = @()",
  "Get-Process -Name Codex,codex,codex-helper -ErrorAction SilentlyContinue | ForEach-Object { $names += $_.ProcessName }",
  `Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq 'ChatGPT.exe' -and $_.ExecutablePath -match '${CODEX_PS_PATH_MATCH}' } | ForEach-Object { $names += $_.Name }`,
  "($names | Sort-Object -Unique) -join ','",
].join("; ");

const CODEX_PS_STOP_FAST = [
  "taskkill /F /IM codex-helper.exe /T 2>$null | Out-Null",
  "Stop-Process -Name Codex,codex,codex-helper -Force -ErrorAction SilentlyContinue",
  "taskkill /F /IM Codex.exe /T 2>$null | Out-Null",
  "taskkill /F /IM codex.exe /T 2>$null | Out-Null",
  "Start-Sleep -Seconds 1",
].join("; ");

const CODEX_PS_STOP_PATH = [
  "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  `  $_.ExecutablePath -match '${CODEX_PS_PATH_MATCH}'`,
  "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
].join("; ");

function listRunningCodexProcesses() {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", CODEX_PS_DETECT],
    { windowsHide: true, encoding: "utf8", timeout: 8000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "无法确认 Codex 是否已退出，已停止修改文件。请退出 ChatGPT/Codex 后重试；若仍失败，请检查进程检测权限。",
    );
  }
  const raw = result.stdout?.trim();
  if (!raw) return [];
  return raw.split(",").filter(Boolean);
}

function stopCodex({ includePathScan = true } = {}) {
  logInfo("正在结束 Codex / codex / codex-helper 进程…");
  spawnSync("powershell", ["-NoProfile", "-Command", CODEX_PS_STOP_FAST], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 20000,
  });
  if (includePathScan) {
    logInfo("正在扫描并结束其他路径下的 Codex 相关进程（约 5–15 秒）…");
    spawnSync("powershell", ["-NoProfile", "-Command", CODEX_PS_STOP_PATH], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 60000,
    });
  }
}

function ensureCodexStopped(step = 1, total = INSTALL_STEP_TOTAL) {
  localizationDiagnostic.step = "stop_processes";
  const running = listRunningCodexProcesses();
  if (running.length === 0) {
    logInfo("Codex 当前未运行。");
    return;
  }

  progressLog(
    step,
    total,
    `检测到 Codex 正在运行（${running.join(", ")}），正在关闭…`,
  );
  stopCodex();

  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const still = listRunningCodexProcesses();
    if (still.length === 0) {
      logOk("Codex 已完全退出。");
      return;
    }
    if (attempt === 4) {
      logInfo("仍有进程未退出，再次尝试强制结束…");
      stopCodex();
    }
    logInfo(
      `等待进程退出… (${attempt}/${maxAttempts}，仍在运行: ${still.join(", ")})`,
    );
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Start-Sleep -Seconds 1"],
      { windowsHide: true, encoding: "utf8", timeout: 5000 },
    );
  }

  const remaining = listRunningCodexProcesses();
  if (remaining.length > 0) {
    throw new Error(
      `无法关闭 Codex（仍在运行: ${remaining.join(", ")}）。请退出 Codex、在托盘右键退出 codex-helper（CodexHelper），或在任务管理器中结束相关进程后重试。`,
    );
  }
}

function findPatchedCodexExe(appDir) {
  // New Store builds use ChatGPT.exe as the real Electron entry point.
  // Codex.exe is only a package activation stub and redirects to the
  // unpatched WindowsApps copy, so it must be a fallback.
  for (const exeName of ["ChatGPT.exe", "Codex.exe", "codex.exe"]) {
    const exePath = path.join(appDir, exeName);
    if (fs.existsSync(exePath)) return exePath;
  }
  return null;
}

function launchCodexExecutable(exePath) {
  const workDir = path.dirname(exePath);
  const escapedExe = exePath.replace(/'/g, "''");
  const escapedDir = workDir.replace(/'/g, "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Start-Process -FilePath '${escapedExe}' -WorkingDirectory '${escapedDir}'`,
    ],
    { windowsHide: true, stdio: "ignore", timeout: 15000 },
  );
}

function launchCodexViaScript(scriptPath) {
  const lower = scriptPath.toLowerCase();
  if (lower.endsWith(".ps1")) {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        scriptPath,
        "-Quiet",
      ],
      { windowsHide: true, stdio: "ignore", timeout: 15000 },
    );
    return;
  }
  spawnSync("cmd.exe", ["/c", scriptPath, "run"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15000,
  });
}

function getInstallLauncherPaths() {
  return {
    bat: path.join(projectRoot, "Codex 汉化版.bat"),
    batAscii: path.join(projectRoot, "launch-codex-zh-cn.bat"),
    ps1: path.join(projectRoot, "launch-codex-zh-cn.ps1"),
    legacyVbs: path.join(projectRoot, "Codex 汉化版.vbs"),
  };
}

function removeStaleLaunchers() {
  const { legacyVbs } = getInstallLauncherPaths();
  const staleNames = ["Codex 汉化版.vbs"];
  const roots = [path.join(os.homedir(), "Desktop"), projectRoot];

  for (const root of roots) {
    for (const name of staleNames) {
      const target = path.join(root, name);
      if (!fs.existsSync(target)) continue;
      try {
        fs.unlinkSync(target);
        logInfo(`已移除旧版 VBS 启动脚本: ${target}`);
      } catch {
        logInfo(`请手动删除旧版 VBS 启动脚本: ${target}`);
      }
    }
  }

  if (fs.existsSync(legacyVbs)) {
    try {
      fs.unlinkSync(legacyVbs);
      logInfo(`已移除旧版 VBS 启动脚本: ${legacyVbs}`);
    } catch {
      logInfo(`请手动删除旧版 VBS 启动脚本: ${legacyVbs}`);
    }
  }
}

/**
 * 从 Store 包的安装目录推出 AUMID（`<PackageFamilyName>!<ApplicationId>`）。
 *
 * 目录名形如 `OpenAI.Codex_26.903.8094.0_x64__2p2nqsd0c76g0`，
 * 其中 `PackageFamilyName = <Name>_<PublisherId>`。
 * Application Id 从 `AppxManifest.xml` 里取（取不到就退回约定值 `App`）。
 */
function resolveStoreAumid(app) {
  const installRoot = path.dirname(app);
  const parts = path.basename(installRoot).split("_");
  if (parts.length < 2 || !parts[0] || !parts[parts.length - 1]) return null;
  const family = `${parts[0]}_${parts[parts.length - 1]}`;
  let applicationId = "App";
  try {
    const manifest = fs.readFileSync(
      path.join(installRoot, "AppxManifest.xml"),
      "utf8",
    );
    const matched = manifest.match(/<Application\b[^>]*\bId="([^"]+)"/);
    if (matched && matched[1]) applicationId = matched[1];
  } catch {
    // manifest 读不到就按约定值走，不影响 AUMID 的主体。
  }
  return `${family}!${applicationId}`;
}

/**
 * 用官方 AUMID 激活 Store 版 Codex。
 *
 * ⚠️ **不要**改成直接执行包里的 `ChatGPT.exe`：打包应用只有在被 AUMID 激活时
 * 才会拿到「程序包标识符」，直接 CreateProcess 会得到
 * APPMODEL_ERROR_NO_PACKAGE（系统弹「该进程没有程序包标识符」）。
 * 2026-09-19 / 09-20 两次踩坑都是这个原因。
 */
function launchStoreCodex(app) {
  const aumid = resolveStoreAumid(app);
  if (!aumid) return false;
  const target = `shell:AppsFolder\\${aumid}`;
  try {
    spawnSync("explorer.exe", [target], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 20000,
    });
    console.log(`[ok] 已通过官方入口启动 Codex: ${aumid}`);
    console.log(`[codex-launch] ${target}`);
    return true;
  } catch (error) {
    console.log(`[warn] 通过官方入口启动失败：${error.message}`);
    return false;
  }
}

function startCodex(app, patchedRoot, mode) {
  // 注册副本：必须走**它自己的** AUMID 激活 —— 直接跑副本里的 exe 会丢包身份
  // （弹「该进程没有程序包标识符」），这也正是当年副本路线被放弃的原因。
  if (mode === "store-register") {
    const registered = queryRegisteredPackage();
    if (registered?.aumid) {
      const target = `shell:AppsFolder\\${registered.aumid}`;
      spawnSync("explorer.exe", [target], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 20000,
      });
      console.log(`[ok] 已按应用身份启动汉化版 Codex: ${registered.aumid}`);
      console.log(`[codex-launch] ${target}`);
      return;
    }
    console.log(
      "[warn] 汉化副本尚未注册成功，无法按应用身份启动；请从开始菜单打开「ChatGPT 汉化版」。",
    );
    return;
  }

  // Store 版一律走官方 AUMID 激活；直接跑包内 exe 会丢包身份（见上）。
  if (isWindowsAppsInstall(app) && launchStoreCodex(app)) return;

  const exePath = findPatchedCodexExe(app);
  if (exePath) {
    launchCodexExecutable(exePath);
    console.log(`[ok] 汉化完成，已重新启动 Codex: ${exePath}`);
    console.log(`[codex-launch] ${exePath}`);
    return;
  }

  const { ps1: installPs1, bat: installBat } = getInstallLauncherPaths();
  const scriptLauncher = [installPs1, installBat].find(
    (candidate) => candidate && fs.existsSync(candidate),
  );
  if (scriptLauncher) {
    launchCodexViaScript(scriptLauncher);
    console.log(`[ok] 汉化完成，已重新启动 Codex: ${scriptLauncher}`);
    console.log(`[codex-launch] ${scriptLauncher}`);
    return;
  }

  console.log("[warn] 未找到 Codex 启动方式，请手动打开 Codex。");
}

function removeDirectoryRobust(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;

  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 400,
    });
    if (!fs.existsSync(targetPath)) return;
  } catch {
    // fall through to PowerShell cleanup
  }

  stopCodex({ includePathScan: false });

  logInfo(`正在清理旧汉化副本: ${targetPath}`);
  logInfo("若目录较大或曾被占用，取得权限可能需要 1–3 分钟…");
  const escaped = targetPath.replace(/'/g, "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      [
        `if (Test-Path -LiteralPath '${escaped}') {`,
        `  takeown /f '${escaped}' /r /d y 2>$null | Out-Null`,
        `  icacls '${escaped}' /grant "$env:USERNAME:(F)" /t /c 2>$null | Out-Null`,
        `  Remove-Item -LiteralPath '${escaped}' -Force -Recurse -ErrorAction SilentlyContinue`,
        `}`,
      ].join(" "),
    ],
    { windowsHide: true, encoding: "utf8", timeout: 180000 },
  );

  if (!fs.existsSync(targetPath)) return;

  const trashPath = `${targetPath}.pending-delete-${Date.now()}`;
  try {
    fs.renameSync(targetPath, trashPath);
    console.log(`[warn] 目录被占用，已重命名为: ${trashPath}`);
    console.log("[warn] 可在重启电脑后手动删除；安装将继续使用新目录。");
  } catch (error) {
    console.warn(
      `[warn] 无法移除旧副本目录（${error.message}），将自动改用新的汉化目录继续安装。`,
    );
  }
}

function preflightToolResources() {
  const required = [
    "native-menu-zh-CN.json", "menu-hardcoded-zh-CN.json",
    "update-prompt-zh-CN.json", "bundled-plugins-zh-CN.json", "release.json",
  ];
  const loaded = {};
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const pairs = (value) => Array.isArray(value) && value.length > 0 && value.every((pair) =>
    Array.isArray(pair) && pair.length === 2 && pair.every((text) => typeof text === "string" && text.length > 0));
  for (const name of required) {
    let value;
    try { value = loadJson(name); }
    catch (error) {
      error.message = `语言包资源不可用 (${name})：${error.message}`;
      throw error;
    }
    const valid = name === "native-menu-zh-CN.json"
      ? object(value) && Object.keys(value).length > 0 && Object.values(value).every((text) => typeof text === "string" && text.length > 0)
      : name === "menu-hardcoded-zh-CN.json" ? pairs(value)
      : name === "update-prompt-zh-CN.json" ? object(value) && value.version === 1 && pairs(value.replacements)
      : name === "release.json" ? object(value) && typeof value.release === "string" && value.release.length > 0
      : object(value) && Object.keys(value).length > 0 && Object.values(value).every((patch) => object(patch) && Object.keys(patch).length > 0 && Object.values(patch).every((text) => typeof text === "string" || (Array.isArray(text) && text.every((item) => typeof item === "string"))));
    if (!valid) throw new Error(`语言包资源格式无效 (${name})`);
    loaded[name] = value;
  }
  for (const relative of ["runtime/main.cjs", "runtime/preload-localization.cjs",
    "launchers/Codex 汉化版.bat", "launchers/launch-codex-zh-cn.bat", "launchers/launch-codex-zh-cn.ps1"]) {
    const file = path.join(projectRoot, relative);
    try {
      if (!fs.statSync(file).isFile()) throw new Error("不是文件");
      const source = fs.readFileSync(file, "utf8");
      if (!source.trim()) throw new Error("文件为空");
      // Parse CJS without requiring Electron or executing any payload.
      if (relative.endsWith(".cjs")) new Function("require", "module", "exports", source);
    } catch (error) {
      error.message = `语言包资源不可用 (${relative})：${error.message}`;
      throw error;
    }
  }
  return loaded;
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(resourcesDir, name), "utf8"));
}

/** 旧版错误补丁：有 submenu 但缺少 id，会导致编辑/窗口菜单无法点击 */
const BROKEN_EDIT_MENU_RE =
  /\{label:`编辑`,submenu:\[[\s\S]*?\{role:`selectAll`,label:`全选`\}\]\}/g;
const BROKEN_WINDOW_MENU_RE =
  /\{label:`窗口`,submenu:\[[\s\S]*?\{role:`close`,label:`关闭`\}\]\}/g;
const ROLE_EDIT_MENU_RE =
  /\{role:`editMenu`,id:([a-zA-Z0-9_.$]+)(?:,label:`编辑`)?\}/g;
const ROLE_WINDOW_MENU_RE =
  /\{role:`windowMenu`,id:([a-zA-Z0-9_.$]+)(?:,label:`窗口`)?\}/g;
const ROLE_HELP_MENU_RE =
  /\{role:`help`,id:([a-zA-Z0-9_.$]+)(?:,label:`帮助`)?(?=,submenu:)/g;

function buildLocalizedEditMenu(id) {
  return `{label:\`编辑\`,id:${id},submenu:[{role:\`undo\`,label:\`撤销\`},{role:\`redo\`,label:\`重做\`},{type:\`separator\`},{role:\`cut\`,label:\`剪切\`},{role:\`copy\`,label:\`复制\`},{role:\`paste\`,label:\`粘贴\`},{role:\`delete\`,label:\`删除\`},{type:\`separator\`},{role:\`selectAll\`,label:\`全选\`}]}`;
}

function buildLocalizedWindowMenu(id) {
  return `{label:\`窗口\`,id:${id},submenu:[{role:\`minimize\`,label:\`最小化\`},{role:\`zoom\`,label:\`缩放\`},{type:\`separator\`},{role:\`close\`,label:\`关闭\`}]}`;
}

function getRoleMenuIdPrefix(mainBundleText) {
  const match = mainBundleText.match(/\{role:`help`,id:([a-zA-Z0-9_.$]+)\}/);
  if (!match) return "t.Dn";
  return match[1].replace(/\.help$/, "");
}

function repairBrokenRoleMenus(text) {
  const prefix = getRoleMenuIdPrefix(text);
  let count = 0;
  const editFix = buildLocalizedEditMenu(`${prefix}.edit`);
  const windowFix = buildLocalizedWindowMenu(`${prefix}.window`);
  const next = text
    .replace(BROKEN_EDIT_MENU_RE, () => {
      count += 1;
      return editFix;
    })
    .replace(BROKEN_WINDOW_MENU_RE, () => {
      count += 1;
      return windowFix;
    });
  return { text: next, count };
}

function localizeRoleMenus(text) {
  let count = 0;
  const next = text
    .replace(ROLE_EDIT_MENU_RE, (_match, id) => {
      count += 1;
      return buildLocalizedEditMenu(id);
    })
    .replace(ROLE_WINDOW_MENU_RE, (_match, id) => {
      count += 1;
      return buildLocalizedWindowMenu(id);
    })
    .replace(ROLE_HELP_MENU_RE, (_match, id) => {
      count += 1;
      return `{role:\`help\`,id:${id},label:\`帮助\``;
    });
  return { text: next, count };
}

const ROLE_MENU_PATCHES = [
  ["About ${n.app.getName()}", "关于 ${n.app.getName()}"],
  ["title:`About ${e}`", "title:`关于 ${e}`"],
  ["KX=`About {appName}`", "KX=`关于 {appName}`"],
  ["{role:`quit`}", "{role:`quit`,label:`退出`}"],
  ["??`Quit ${e}`", "??`退出 ${e}`"],
];

const WEBVIEW_TEXT_PATCHES = [["title:`Featured`", "title:`精选`"]];

function patchRoleMenus(content) {
  let text = content.toString("utf8");
  let count = 0;
  const repaired = repairBrokenRoleMenus(text);
  text = repaired.text;
  count += repaired.count;
  if (repaired.count > 0) {
    logInfo(`已修复 ${repaired.count} 处旧版编辑/窗口菜单补丁。`);
  }
  const localized = localizeRoleMenus(text);
  text = localized.text;
  count += localized.count;
  if (localized.count > 0) {
    logInfo("已为编辑/窗口菜单写入中文子项（保留菜单 id）。");
  }
  for (const [source, target] of ROLE_MENU_PATCHES) {
    if (!text.includes(source)) continue;
    const matches = text.split(source).length - 1;
    text = text.replaceAll(source, target);
    count += matches;
  }
  return { buffer: Buffer.from(text, "utf8"), count };
}

function patchWebviewBundles(asarPath, replacements = WEBVIEW_TEXT_PATCHES) {
  logInfo("正在读取 app.asar（仅一次）…");
  const data = Buffer.from(fs.readFileSync(asarPath));
  const parsed = readAsarHeader(data, asarPath);
  const candidates = [];
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (filePath.includes("webview/assets/") && filePath.endsWith(".js")) {
      candidates.push(filePath);
    }
  }

  const total = candidates.length;
  logInfo(`共 ${total} 个 webview 脚本，开始扫描并打补丁…`);

  const state = { data, parsed, label: asarPath };
  let count = 0;
  let officialI18nGatePatched = false;
  let officialI18nGateFound = false;
  let lastPct = -1;

  for (let index = 0; index < candidates.length; index += 1) {
    const filePath = candidates[index];
    const current = index + 1;
    const pct = total > 0 ? Math.floor((current / total) * 100) : 100;
    if (pct !== lastPct || current === 1 || current === total) {
      logProgressBar(current, total, path.basename(filePath));
      lastPct = pct;
    }

    const entry = getAsarFileEntry(state.parsed.header, filePath);
    const offset = 8 + state.parsed.headerSize + Number(entry.offset);
    const text = state.data
      .subarray(offset, offset + Number(entry.size))
      .toString("utf8");
    let next = text;
    for (const [source, target] of replacements) {
      if (next.includes(source)) next = next.replaceAll(source, target);
    }
    const i18nGate = patchOfficialI18nGateSource(next);
    if (i18nGate) {
      next = i18nGate.source;
      officialI18nGateFound = true;
      officialI18nGatePatched ||= i18nGate.changed;
    }
    if (next === text) continue;
    applyAsarBufferPatch(state, filePath, Buffer.from(next, "utf8"));
    count += 1;
    logOk(`webview 补丁: ${path.basename(filePath)}`);
  }

  logProgressBar(total, total, "扫描完成");
  if (count > 0) {
    logInfo(`正在写回 app.asar（已修改 ${count} 个文件）…`);
    writeInstallFile(asarPath, state.data);
  } else {
    logInfo("webview 文案无需修改，跳过写回。");
  }
  return { count, officialI18nGatePatched, officialI18nGateFound };
}

/**
 * 把副本自己弹的「去商店更新」提示，改成引导用户回客户端点「一键汉化」。
 *
 * 为什么必须动这块：汉化版是一份**松散注册的副本**（包名 `OpenAI.Codex.FMKJ`、
 * `SignatureKind=None`），Microsoft Store 不认它 ⇒ 桌面端内建的更新器
 * （`.vite/build/bootstrap-*.js` 里那个 store updater）做不到静默下载，
 * 只会走到 `update-available-in-store` 这一支，弹一句
 * 「… update is available. / Open Microsoft Store to install the update.」。
 * 用户照着点，装回来 / 更新的是**官方英文版**，中文版还停在旧版本 ——
 * 一个走不通的入口。
 *
 * ⚠️ 只改这两句**界面文案**，一行更新逻辑都不碰。真出现新版时该怎么办，由
 * 安装器那边判断（它读 `~/.codex/zh-cn-registered.json` 的来源版本，比 Codex 自己更清楚
 * 里有来源版本，能拿本机商店版一比）；在这里改判定只会在下次 Codex 换写法时
 * 静默失灵，还会把「有没有新版」这条信息本身弄丢。
 *
 * 匹配用的是 `resources/update-prompt-zh-CN.json` 里那几条**完整字符串字面量**
 * （替换规则与「出现多次就不碰」的判定都在 `localization-patches.mjs` 的
 * `applyUpdatePromptPatches()` 里，有单测覆盖）。
 */
function patchUpdatePromptBundles(asarPath, translations) {
  const pairs = Array.isArray(translations?.replacements)
    ? translations.replacements
    : [];
  if (pairs.length === 0) {
    logInfo("更新提示文案补丁为空，跳过。");
    return { count: 0, replaced: 0 };
  }

  const data = Buffer.from(fs.readFileSync(asarPath));
  const parsed = readAsarHeader(data, asarPath);
  const candidates = [];
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (filePath.includes(".vite/build/") && filePath.endsWith(".js")) {
      candidates.push(filePath);
    }
  }

  const state = { data, parsed, label: asarPath };
  let count = 0;
  let replaced = 0;

  for (const filePath of candidates) {
    const entry = getAsarFileEntry(state.parsed.header, filePath);
    const offset = 8 + state.parsed.headerSize + Number(entry.offset);
    const text = state.data
      .subarray(offset, offset + Number(entry.size))
      .toString("utf8");
    const result = applyUpdatePromptPatches(text, pairs);
    if (result.ambiguous > 0) {
      logInfo(
        `${path.basename(filePath)} 里有 ${result.ambiguous} 条文案出现多次，已跳过以免误伤。`,
      );
    }
    if (!result.changed) continue;
    applyAsarBufferPatch(state, filePath, Buffer.from(result.source, "utf8"));
    count += 1;
    replaced += result.applied;
    logOk(
      `更新提示文案补丁: ${path.basename(filePath)}（${result.applied} 处）`,
    );
  }

  if (count > 0) {
    logInfo(`正在写回 app.asar（更新提示，已修改 ${count} 个文件）…`);
    writeInstallFile(asarPath, state.data);
  }
  return { count, replaced };
}

function injectRuntimeBootstrap(content) {
  const text = content.toString("utf8");
  // 开源版把本工具的 `runtime/` 目录**编译期写进**引导里，不再依赖客户端私有目录
  // （`%LOCALAPPDATA%\FMKJ Connect\Tools\`）或按版本号挑子目录。历史上这条链只要
  // 目录名和常量对不上，`require` 抛错就被 `catch` 吞掉，表现为「提示成功但不汉化」。
  const result = injectRuntimeBootstrapSource(text, RUNTIME_DIR);
  return {
    buffer: result.changed ? Buffer.from(result.source, "utf8") : content,
    count: result.changed ? 1 : 0,
  };
}
function patchMainBundle(content, pairs) {
  let text = content.toString("utf8");
  let count = 0;
  for (const [source, target] of pairs) {
    const pattern = `(?<quote>[\`"'])${escapeRegExp(source)}\\k<quote>`;
    const re = new RegExp(pattern, "g");
    const before = text;
    text = text.replace(re, (_m, quote) => {
      count += 1;
      return `${quote}${target}${quote}`;
    });
    if (text === before) {
      const labelPattern = `label:\`${escapeRegExp(source)}\``;
      const labelRe = new RegExp(labelPattern, "g");
      text = text.replace(labelRe, () => {
        count += 1;
        return `label:\`${target}\``;
      });
    }
  }
  return { buffer: Buffer.from(text, "utf8"), count };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Codex bundles have used three wrappers for locale data:
//   older:    ...};export{...}
//   classic:  ...}}))();export{...}
//   26.915+:  ...}})))()}r();export{...}
// In all cases additions belong immediately before the locale object's
// closing brace. Keep the old markers for backwards compatibility.
//
// ⚠️ 定位一旦失败，补词条就没有落点了。`assertSourceAsarPatchable`
//    会用**同一个判据**在「复制 1.9 GB 之前」先探一次，避免白复制一场。
const ZH_BUNDLE_EXPORT_MARKERS = ["}}))();export", "};export"];

/**
 * 定位 zh-CN bundle 里「词条对象闭合大括号」的位置（新词条插在它之前）。
 *
 * 26.915 起 rolldown 把 locale 初始化包进了**惰性初始化函数**：
 *   var t,n;function r(){return(r=e((()=>{ … }})))()}r();export{n as default,t as kKSGje};
 * 于是 `}}))();export` 不再命中（中间多了 `)}r();`）。包装函数名（上面的 r）
 * 会随压缩变化，**不能写死**；因此兜底策略是：找最后一个 `export{`，
 * 再往前找最近的 `}}`——不依赖任何变量名。
 */
function locateZhBundleInsertAt(text) {
  for (const marker of ZH_BUNDLE_EXPORT_MARKERS) {
    const at = text.lastIndexOf(marker);
    if (at >= 0) return at;
  }
  const exportAt = text.lastIndexOf("export{");
  if (exportAt < 0) return -1;
  const objectEnd = text.lastIndexOf("}}", exportAt);
  if (objectEnd < 0) return -1;
  // 两者距离过远说明结构超出预期，宁可判失败，也不在错误位置插词条。
  if (exportAt - objectEnd > 400) return -1;
  return objectEnd;
}

function patchZhBundle(content, menuTitleMap) {
  let text = content.toString("utf8");
  const additions = [];
  for (const [key, value] of Object.entries(menuTitleMap)) {
    if (text.includes(`"${key}":`)) continue;
    additions.push(
      `"${key}":\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``,
    );
  }
  if (additions.length === 0) return { buffer: content, count: 0 };
  const insertAt = locateZhBundleInsertAt(text);
  if (insertAt < 0) {
    throw new Error(
      "无法定位 zh-CN bundle 导出位置（当前 Codex 资源格式可能已更新）。",
    );
  }
  const prefix = additions.length > 0 ? "," : "";
  text =
    text.slice(0, insertAt) +
    prefix +
    additions.join(",") +
    text.slice(insertAt);
  return { buffer: Buffer.from(text, "utf8"), count: additions.length };
}

function setCodexLocale() {
  const codexHome = path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });

  let content = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const block = `[desktop]\nlocaleOverride = "zh-CN"\n`;
  if (/^\[desktop\]/m.test(content)) {
    if (/localeOverride\s*=/.test(content)) {
      content = content.replace(
        /localeOverride\s*=\s*"[^"]*"/,
        'localeOverride = "zh-CN"',
      );
    } else {
      content = content.replace(/\[desktop\]\s*\n?/, block);
    }
  } else {
    content = `${content.trimEnd()}\n\n${block}`;
  }
  fs.writeFileSync(configPath, content, "utf8");
  console.log(`[ok] 已写入 ${configPath}`);
}

function restoreCodexLocale() {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  if (!fs.existsSync(configPath)) return;
  let content = fs.readFileSync(configPath, "utf8");
  content = content.replace(
    /localeOverride\s*=\s*"zh-CN"/,
    'localeOverride = "en-US"',
  );
  fs.writeFileSync(configPath, content, "utf8");
  console.log(`[ok] 已恢复语言配置 ${configPath}`);
}

function backupFile(filePath, backupRoot) {
  if (!fs.existsSync(filePath)) return;
  const rel = path.basename(filePath);
  const target = path.join(backupRoot, rel);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.copyFileSync(filePath, target);
    console.log(`[backup] ${rel}`);
  }
}

function restoreBackup(backupRoot, targetDir, fileName) {
  const source = path.join(backupRoot, fileName);
  const target = path.join(targetDir, fileName);
  if (!fs.existsSync(source)) return false;
  ensureInstallWritable(target);
  writeInstallFile(target, fs.readFileSync(source));
  console.log(`[restore] ${fileName}`);
  return true;
}

function getCodexHome() {
  return path.join(os.homedir(), ".codex");
}

/**
 * 把语言包目录写进 `~/.codex/zh-cn-runtime-path.txt`（引导的兜底路径）与
 * `zh-cn-runtime-path.json`（卸载定位 / 用户排查用）。
 *
 * 引导里内联的是**本工具**的 `runtime/` 目录，工具没搬走就一定命中；
 * 用户把整个工具目录挪到别处后，引导读这个文件回退，不至于一搬家就静默失效。
 */
function writeRuntimePathHint(runtimeDir) {
  try {
    fs.mkdirSync(getCodexHome(), { recursive: true });
    fs.writeFileSync(
      path.join(getCodexHome(), "zh-cn-runtime-path.txt"),
      `${path.normalize(runtimeDir)}\n`,
      "utf8",
    );
    let release = null;
    try {
      release = loadJson("release.json").release;
    } catch {}
    fs.writeFileSync(
      path.join(getCodexHome(), "zh-cn-runtime-path.json"),
      JSON.stringify(
        {
          runtimeDir: path.normalize(runtimeDir),
          release,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    logInfo(`写入语言包路径记录失败（不影响汉化）: ${error.message}`);
  }
}

/** 安装前确认语言包运行时在位；缺文件就报错，不要装出个不汉化的东西。 */
function assertRuntimePresent(runtimeDir) {
  const missing = [
    path.join(runtimeDir, "main.cjs"),
    path.join(runtimeDir, "preload-localization.cjs"),
  ].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `语言包运行时缺失：${missing.join("、")}。请完整解压发布包，不要只拷脚本目录。`,
    );
  }
}

/** 卸载时清掉路径提示与运行时状态，避免下次装到旧路径。 */
function removeRuntimePathHint() {
  const files = [
    path.join(getCodexHome(), "zh-cn-runtime-path.txt"),
    path.join(getCodexHome(), "zh-cn-runtime-path.json"),
    getRuntimeStatusPath(),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      logInfo(`请手动删除: ${file}`);
    }
  }
}

function isWindowsAppsInstall(targetPath) {
  const normalized = path.normalize(targetPath).toLowerCase();
  return normalized.includes(`${path.sep}windowsapps${path.sep}`);
}

function getInstallBackupRoot(app) {
  const key = crypto
    .createHash("sha256")
    .update(path.normalize(app).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return path.join(getCodexHome(), "zh-cn-install-backups", key, "latest");
}

function resolveBackupRoot(app, resources) {
  const userRoot = getInstallBackupRoot(app);
  if (fs.existsSync(path.join(userRoot, "app.asar"))) return userRoot;
  const legacyRoot = path.join(resources, ".zh-cn-backups", "latest");
  if (fs.existsSync(path.join(legacyRoot, "app.asar"))) return legacyRoot;
  return userRoot;
}

function ensureInstallWritable(...targets) {
  const paths = [
    ...new Set(
      targets
        .filter(Boolean)
        .map((p) => path.normalize(p))
        .filter((p) => isWindowsAppsInstall(p)),
    ),
  ];
  if (paths.length === 0) return;

  console.log("[info] 正在调整 WindowsApps 文件权限（Microsoft Store 安装）…");
  // ⚠️ 只授权**要写的那个文件本身**，绝不碰目录。
  // 汉化的每一处落盘都是原地覆写（`writeInstallFile` → `writeFileSync`，
  // 不做「写临时文件再 rename」），所以给到文件 ACL 就够；反过来若动了
  // `app` / `resources` 目录的属主，WindowsApps 里就多出一个「属主不是
  // TrustedInstaller」的目录，徒增 Store 修复 / 更新时的意外。
  // 影响面必须压到最小 —— 这是这个函数存在的全部意义。
  //
  // ⛔ **在 Win11 24H2 上这套调整本身已经无效**：24H2 从系统层面封死了
  // WindowsApps 的写盘 —— `takeown`/`icacls` 能成功（退出码 0），但紧接着的
  // 写入仍然报 EPERM，提权也一样。所以这里只为**存量机器**保留（卸载旧补丁时
  // 要能把文件还原回去），别再把「重新授权」当成汉化失败时的重试手段
  // （三条独立证据见 TRAPS.md「24H2 封死 WindowsApps 写盘」）。
  // 退出码照旧收集：它至少能区分「授权本身失败」和「授权成功但系统不让写」。
  const lines = ["$fails = ''"];
  for (const target of paths) {
    const escaped = target.replace(/'/g, "''");
    lines.push(
      `$t = '${escaped}'`,
      "if (Test-Path -LiteralPath $t) {",
      "  & takeown.exe /f $t /a 2>$null | Out-Null",
      '  if ($LASTEXITCODE -ne 0) { $fails += "takeown=$LASTEXITCODE;" }',
      "  & icacls.exe $t /grant 'Administrators:(F)' /C 2>$null | Out-Null",
      '  if ($LASTEXITCODE -ne 0) { $fails += "icacls-admin=$LASTEXITCODE;" }',
      '  & icacls.exe $t /grant "$env:USERNAME:(F)" /C 2>$null | Out-Null',
      '  if ($LASTEXITCODE -ne 0) { $fails += "icacls-user=$LASTEXITCODE;" }',
      "}",
    );
  }
  lines.push(
    'Write-Output "fails=$fails"',
    "if ($fails) { exit 1 } else { exit 0 }",
  );
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", lines.join("\n")],
    { windowsHide: true, encoding: "utf8", timeout: 120000 },
  );
  if (result.status !== 0) {
    // 旧写法把 takeown / icacls 的输出整个 `2>$null` 掉了，`detail` 于是恒为空：
    // 用户只看到一句没头没尾的「权限调整可能不完整」，事后也查不出是哪一步失败。
    // 改成显式收集每一步的退出码 —— 这个诊断信息必须留下来。
    const detail = (result.stdout || "").trim().replace(/^fails=/, "");
    console.warn(
      `[warn] 权限调整可能不完整${detail ? `（${detail}）` : ""}，将继续尝试写入…`,
    );
  }
}

function prepareInstallWriteAccess(app, resources, asarPath) {
  localizationDiagnostic.step = "write_access";
  // 只列**真正会被写的文件**：app.asar（汉化补丁）与 Electron 入口 exe
  // （要同步内嵌的 asar 完整性哈希）。目录一概不碰 —— 理由见
  // `ensureInstallWritable` 里的注释。
  void resources;
  ensureInstallWritable(
    asarPath,
    ...CODEX_EXE_CANDIDATES.map((name) => path.join(app, name)).filter((p) =>
      fs.existsSync(p),
    ),
  );
}

function writeInstallFile(filePath, data) {
  fs.writeFileSync(filePath, data);
}

/**
 * 写权限预检：Store 版要改写的是 `C:\Program Files\WindowsApps` 里的官方包，
 * 那是 TrustedInstaller 保护目录 —— 授权失败时真正的报错只有一句 `EPERM`，
 * 用户完全不知道该干什么。这里换成一句能照做的提示。
 */
function assertInstallWritable(asarPath) {
  try {
    const handle = fs.openSync(asarPath, "r+");
    fs.closeSync(handle);
  } catch (error) {
    // 给 Connect 客户端的机器可读信号：它据此**自动提权重跑**，用户不必自己
    // 去「以管理员身份运行本工具」。标记必须走 stderr —— 客户端的提权兜底是
    // 从工具的错误文本里认它的（提权/管道那条路径只收集 stderr）。
    //
    // ⚠️ 仅对 WindowsApps 目标发这个信号。便携版目录也可能是只读的（比如被
    // 别的安全软件锁住），那种情况下提权解决不了问题，别让客户端白弹 UAC。
    if (isWindowsAppsInstall(asarPath)) {
      process.stderr.write(
        "[codex-zh-cn-need-admin] 需要管理员权限改写 Microsoft Store 安装目录\n",
      );
    }
    throw new Error(
      "无法写入 Codex 安装目录（Microsoft Store 安装位于系统受保护目录）。" +
        "请以管理员身份重新运行本工具后再试。" +
        `（${error.code || error.message}）`,
    );
  }
}

function getPatchedAppKey(sourceApp) {
  return crypto
    .createHash("sha256")
    .update(path.normalize(sourceApp).toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function getActivePatchedRootFile() {
  return path.join(getCodexHome(), "zh-cn-patched-active.txt");
}

function readActivePatchedRootRecord() {
  try {
    const lines = fs
      .readFileSync(getActivePatchedRootFile(), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    if (lines.length === 0) return null;
    return { root: lines[0], sourceApp: lines[1] || "" };
  } catch {
    return null;
  }
}

function writeActivePatchedRootRecord(patchedRoot, sourceApp) {
  fs.mkdirSync(getCodexHome(), { recursive: true });
  fs.writeFileSync(
    getActivePatchedRootFile(),
    `${patchedRoot}\n${sourceApp}\n`,
    "utf8",
  );
}

function getPatchedAppRoot(sourceApp) {
  const active = readActivePatchedRootRecord();
  if (
    active?.root &&
    fs.existsSync(active.root) &&
    (!sourceApp || active.sourceApp === sourceApp)
  ) {
    return active.root;
  }
  const key = getPatchedAppKey(sourceApp);
  return path.join(getCodexHome(), "zh-cn-patched", key);
}

function readPatchedAppMarker(patchedRoot) {
  const marker = path.join(patchedRoot, ".zh-cn-source.txt");
  try {
    return fs.readFileSync(marker, "utf8").trim();
  } catch {
    return "";
  }
}

function ensurePatchedAppCopy(sourceApp, { skipStop = false } = {}) {
  let patchedRoot = getPatchedAppRoot(sourceApp);
  let patchedApp = path.join(patchedRoot, "app");
  let patchedAsar = path.join(patchedApp, "resources", "app.asar");

  if (
    readPatchedAppMarker(patchedRoot) === sourceApp &&
    fs.existsSync(patchedAsar)
  ) {
    logInfo("已存在可写副本，跳过复制。");
    writeActivePatchedRootRecord(patchedRoot, sourceApp);
    return {
      app: patchedApp,
      resources: path.join(patchedApp, "resources"),
      patchedRoot,
    };
  }

  progressLog(3, INSTALL_STEP_TOTAL, "准备 Store 版可写副本…");
  logInfo(`源目录: ${sourceApp}`);
  logInfo(`目标目录: ${patchedRoot}`);
  if (!skipStop) {
    ensureCodexStopped(3, INSTALL_STEP_TOTAL);
  }
  removeDirectoryRobust(patchedRoot);
  if (fs.existsSync(patchedRoot)) {
    const key = getPatchedAppKey(sourceApp);
    patchedRoot = path.join(
      getCodexHome(),
      "zh-cn-patched",
      `${key}-${Date.now()}`,
    );
    patchedApp = path.join(patchedRoot, "app");
    patchedAsar = path.join(patchedApp, "resources", "app.asar");
    console.log(`[warn] 旧副本目录被占用，已改用新目录: ${patchedRoot}`);
  }

  fs.mkdirSync(patchedRoot, { recursive: true });
  progressLog(
    3,
    INSTALL_STEP_TOTAL,
    "正在复制 Codex 文件到用户目录（首次约 2–5 分钟，请勿关闭窗口）…",
  );
  const copyStarted = Date.now();
  runWithProgressHeartbeat("正在复制 Codex 文件", () => {
    fs.cpSync(sourceApp, patchedApp, { recursive: true });
  });
  const copySeconds = Math.round((Date.now() - copyStarted) / 1000);
  fs.writeFileSync(
    path.join(patchedRoot, ".zh-cn-source.txt"),
    sourceApp,
    "utf8",
  );
  writeActivePatchedRootRecord(patchedRoot, sourceApp);
  logOk(`副本复制完成（耗时 ${copySeconds} 秒）: ${patchedApp}`);
  return {
    app: patchedApp,
    resources: path.join(patchedApp, "resources"),
    patchedRoot,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 「汉化副本 + 松散注册」路线（2026-09-20 起取代原地汉化）
//
// 背景：Win11 24H2 从系统层面封死了 `WindowsApps` 的写盘 —— 原地改写商店包
// 无论提不提权都必然 EPERM（三条独立证据见 TRAPS.md）。新路线**不动商店包**：
// 把整包复制到用户目录、改掉包身份、用 `Add-AppxPackage -Register` 松散注册成
// **一个独立的应用**，启动改走副本的 AUMID，副本里的 exe 于是拿得到包身份。
//
// 注册只卡三件事（实测）：**开发者模式 / 管理员权限 / 服务名唯一**。
// 受限能力（packagedServices、localSystemServices）、执行别名重名、协议、
// 文件关联都不会拦注册。
// ─────────────────────────────────────────────────────────────────────────

/** 隐藏窗口、不弹控制台地跑一段 PowerShell。 */
function runPowerShell(script, { timeout = 180000 } = {}) {
  return spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout },
  );
}

/**
 * 从「含 resources 的那一层」（`<包根>\app`）反推 AppX 包根。
 * 注册要的是包根 —— `AppxManifest.xml` 在那里。
 */
function resolveAppxPackageRoot(app) {
  const parent = path.dirname(app);
  if (fs.existsSync(path.join(parent, "AppxManifest.xml"))) return parent;
  if (fs.existsSync(path.join(app, "AppxManifest.xml"))) return app;
  return null;
}

/**
 * 目录是不是客户端自己装的「受管便携版」。
 *
 * 判据是 `localization-patches.mjs` 的 `MANAGED_PORTABLE_MARKER`（`.codex-managed`）。
 * 为什么不能只看「有没有 `AppxManifest.xml`」——那份清单便携根里也有，
 * 完整推理见 `decideLocalizationTargetKind` 的注释。
 */
function isManagedPortableInstall(root) {
  return (
    Boolean(root) && fs.existsSync(path.join(root, MANAGED_PORTABLE_MARKER))
  );
}

/**
 * 这个包根是不是**真的注册在系统里**（而不是解包/复制出来的目录）。
 *
 * 两条判据任一成立即可：
 *   1) 路径落在 `WindowsApps` 下 —— 商店包只可能装在那里（顺带避开 PowerShell
 *      抖动造成的误判：商店目标永远不会走到第 2 条）；
 *   2) 清单里的包名能通过 `Get-AppxPackage` 查到，且查回来的 `InstallLocation`
 *      就是它自己 —— 防「同名但另一处」的解包目录蒙混过关。
 */
function isRegisteredPackageRoot(root) {
  if (!root) return false;
  if (isWindowsAppsInstall(root)) return true;
  const name = readManifestIdentityField(root, "Name");
  if (!name) return false;
  // 单行写法：Windows PowerShell 5.1 不支持「行首竖线」续行。
  const script =
    `$p = Get-AppxPackage -Name '${name.replace(/'/g, "''")}' ` +
    "-ErrorAction SilentlyContinue | Sort-Object Version -Descending " +
    "| Select-Object -First 1 -ExpandProperty InstallLocation; " +
    "if ($p) { Write-Output $p }";
  const result = runPowerShell(script, { timeout: 60000 });
  const location = String(result.stdout || "").trim();
  return Boolean(location) && sameWindowsPath(location, root);
}

/** 读包清单 `Identity` 上的某个属性（`Version` 等），读不到返回 null。 */
function readManifestIdentityField(root, name) {
  try {
    const text = fs.readFileSync(path.join(root, "AppxManifest.xml"), "utf8");
    const matched = text.match(
      new RegExp(`<Identity\\b[^>]*\\b${name}="([^"]+)"`),
    );
    return matched?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 源包的版本号。写进副本标记，用来判断「汉化跟得上商店更新没有」。 */
function readSourcePackageVersion(root) {
  if (!root) return "";
  return (
    readManifestIdentityField(root, "Version") ||
    (path.basename(root).split("_")[1] ?? "")
  );
}

/**
 * 查已注册的副本包；没装或查询失败返回 null。
 *
 * AUMID 只能这样查回来：副本目录名是我们自己起的（`CodexZhCN`），
 * 推不出 `PackageFamilyName`，必须问系统要。
 */
function queryRegisteredPackage(packageName = REGISTERED_PACKAGE_NAME) {
  const script = [
    `$p = Get-AppxPackage -Name '${packageName}' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1`,
    "if (-not $p) { exit 2 }",
    "$id = 'App'",
    "try { $m = Get-AppxPackageManifest $p; $id = @($m.Package.Applications.Application.Id)[0] } catch {}",
    "Write-Output ($p.PackageFamilyName + '!' + $id)",
    "Write-Output $p.Version",
    "Write-Output $p.InstallLocation",
  ].join("\n");
  const result = runPowerShell(script, { timeout: 60000 });
  if (result.status !== 0) return null;
  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;
  return { aumid: lines[0], version: lines[1], installLocation: lines[2] };
}

/**
 * 副本注册所需的「开发者模式」是否已开。
 *
 * 未开时 `Add-AppxPackage -Register` 直接报 `0x80073CFF`。这个开关就是
 * 「设置 → 系统 → 开发者选项」那一个（可随时关掉）。
 */
function isDeveloperModeEnabled() {
  const script = [
    "$k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock'",
    "if (Test-Path $k) { [int](Get-ItemProperty $k -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense } else { 0 }",
  ].join("\n");
  const result = runPowerShell(script, { timeout: 30000 });
  return String(result.stdout || "")
    .trim()
    .startsWith("1");
}

/**
 * 没开就打开它；开不了就抛 `[codex-zh-cn-need-devmode]` 让上层提权重跑。
 *
 * 为什么是「自己开」而不是「只抛错让用户去设置里点」：注册副本这条路**必须**有
 * 这个开关，而客户端点「一键汉化」时已经为注册那一步授权过一次 UAC ——
 * 让用户自己再去「设置 → 系统 → 开发者选项」翻一遍，是这个流程里唯一
 * 非技术用户过不去的一道坎。所以：**当前进程已经是管理员 ⇒ 顺手写注册表开掉**
 * （写之前那一次 UAC 就是用户的授权），**不是管理员 ⇒ 抛信号**，由客户端
 * 提权重跑，工具随之拿到管理员权限再开。
 *
 * 开的两个值就是「设置 → 开发者选项」那一个开关本身：
 * `AllowDevelopmentWithoutDevLicense`（免开发者许可证安装）与
 * `AllowAllTrustedApps`（允许安装受信任应用）。两者都可随时关掉，
 * 不下载、不上报任何东西。
 *
 * 用 PowerShell 的注册表 provider 写，**不调 `reg.exe`** —— 本机安全策略
 * 把 `reg.exe` 拉黑了（见 TRAPS.md），而 provider 直接走 Win32 API，不受影响。
 */
function ensureDeveloperMode() {
  if (isDeveloperModeEnabled()) return false;

  const script = [
    "$k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock'",
    "try {",
    "  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }",
    "  New-ItemProperty -Path $k -Name AllowDevelopmentWithoutDevLicense -Value 1 -PropertyType DWord -Force | Out-Null",
    "  New-ItemProperty -Path $k -Name AllowAllTrustedApps -Value 1 -PropertyType DWord -Force | Out-Null",
    "  if ([int](Get-ItemProperty $k -Name AllowDevelopmentWithoutDevLicense).AllowDevelopmentWithoutDevLicense -eq 1) { 'DEVMODE_OK' } else { 'DEVMODE_FAIL' }",
    "} catch { 'DEVMODE_FAIL: ' + $_.Exception.Message }",
  ].join("\n");
  const result = runPowerShell(script, { timeout: 60000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;

  if (output.includes("DEVMODE_OK")) {
    logOk(
      "已开启 Windows 开发者模式（注册独立应用所需，可在「设置 → 系统 → 开发者选项」中随时关闭）。",
    );
    return true;
  }

  // 与 `[fmkj-need-admin]` 同一套约定：stderr 上的信号才是客户端认的那个，
  // 它据此提权重跑（**提权后本函数会再走一遍，这次就写得进去了**）。
  process.stderr.write(
    "[codex-zh-cn-need-devmode] 注册汉化副本需要开启 Windows 开发者模式\n",
  );
  const detail = output.replace(/^.*DEVMODE_FAIL:?\s*/, "").trim();
  throw new Error(
    "汉化需要把 Codex 复制成一份独立应用再注册，这一步要求开启 Windows 开发者模式" +
      "（注册独立应用是系统层面的操作，只能用这个开关放行）。" +
      "请重新点「一键汉化」并在系统弹窗中选择「是」，工具会自动开启。" +
      (detail ? `（系统返回：${detail}）` : ""),
  );
}

/**
 * 把副本的 `AppxManifest.xml` 改成「可作为独立包注册」的样子。
 *
 * 三处必须改（2026-09-20 实测）：
 *  1. `Identity/@Name` → `OpenAI.Codex.FMKJ` —— 不改就与商店版撞名，注册必失败；
 *  2. 沙箱服务名 → `CodexSandboxService.OpenAI.Codex.FMKJ` —— 不改会报
 *     `0x80073CF6`，内层是 `0x80073D26`「存在安装了不同版本的服务」；
 *  3. `<DisplayName>` 与 `<uap:VisualElements DisplayName>` → 让用户在开始菜单
 *     能一眼认出这是汉化版。
 *
 * ⚠️ 这里**不动** `windows.firewallRules` 声明（2026-09-21 改）：健康机器带着它注册
 * 才是想要的结果 —— 副本因此留下几条入站端口预授权。只有注册真被防火墙服务拒绝
 * （`0x800706D9`）时，才由 `registerAppxCopy()` 删掉声明重试一次。更早的版本在这里
 * 无条件先删，等于让所有机器替少数坏机器买单。
 */
function patchRegisteredManifest(root) {
  const manifestPath = path.join(root, "AppxManifest.xml");
  // 与实测保持一致：读时去掉 BOM，写回不加 BOM。
  const text = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  const identity = text.match(/<Identity\b[^>]*\bName=["']([^"']+)["']/)?.[1];
  if (
    ![
      "OpenAI.Codex",
      "OpenAI.Codex_customer-install",
      REGISTERED_PACKAGE_NAME,
    ].includes(identity)
  ) {
    throw new Error("汉化副本清单不是受支持的 Codex 包，已停止注册。");
  }
  const patched = text
    .replace(
      /(<Identity\b[^>]*\bName=)(["'])OpenAI\.Codex(?:_customer-install)?\2/,
      `$1$2${REGISTERED_PACKAGE_NAME}$2`,
    )
    .replace(
      /\b(Name|EntryPoint)=(["'])CodexSandboxService\.OpenAI\.Codex(?:_customer-install)?\2/g,
      `$1=$2${REGISTERED_SERVICE_NAME}$2`,
    )
    .replace(
      /<DisplayName>ChatGPT<\/DisplayName>/g,
      `<DisplayName>${REGISTERED_DISPLAY_NAME}</DisplayName>`,
    )
    .replace(
      /(<uap:VisualElements\b[^>]*?\bDisplayName=")ChatGPT(")/g,
      `$1${REGISTERED_DISPLAY_NAME}$2`,
    );

  if (patched === text) {
    logInfo("副本清单已符合要求，无需改写。");
    return false;
  }
  fs.writeFileSync(manifestPath, patched, "utf8");
  logOk("已改写副本清单（包名 / 沙箱服务名 / 显示名；防火墙声明原样保留）。");
  return true;
}

/** 递归清掉只读属性 —— 商店包带过来的只读位会挡住后续写入。 */
function clearReadOnlyAttributes(root) {
  let cleared = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (!(fs.statSync(full).mode & 0o200)) {
          fs.chmodSync(full, entry.isDirectory() ? 0o777 : 0o666);
          cleared += 1;
        }
      } catch {}
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return cleared;
}

/**
 * 把商店版整包复制到用户目录（实测 1.89 GB / 3541 文件 / 77 秒）。
 *
 * 必须排除 `APPX_COPY_EXCLUDES`：原包的签名与块映射对新包名不再有效，
 * 留着会让注册直接失败。`/COPY:DT` 刻意不带 `A`，免得把只读属性一并搬过来。
 */
function copyStorePackage(sourceRoot, targetRoot) {
  removeDirectoryRobust(targetRoot);
  if (fs.existsSync(targetRoot)) {
    throw new Error(
      `副本目录被占用，无法清理：${targetRoot}。请关闭 Codex 后重试。`,
    );
  }
  fs.mkdirSync(targetRoot, { recursive: true });

  const args = [
    sourceRoot,
    targetRoot,
    "/E",
    "/COPY:DT",
    "/R:0",
    "/W:0",
    "/NFL",
    "/NDL",
    "/NP",
    "/NJH",
    "/NJS",
  ];
  for (const excluded of APPX_COPY_EXCLUDES) {
    const full = path.join(sourceRoot, excluded);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    args.push(isDir ? "/XD" : "/XF", full);
  }

  const started = Date.now();
  const result = spawnSync("robocopy", args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 900000,
  });
  // robocopy 用 0–7 表示成功（1 = 有文件被复制），>= 8 才是真错误。
  if (result.status === null || result.status >= 8) {
    throw new Error(
      `复制 Codex 文件失败（robocopy 退出码 ${result.status}）。` +
        "请确认磁盘剩余空间充足后重试。",
    );
  }
  clearReadOnlyAttributes(targetRoot);
  return Math.round((Date.now() - started) / 1000);
}

/** 两个 Windows 路径是否指同一处（忽略大小写、斜杠方向与结尾分隔符）。 */
function sameWindowsPath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) =>
    path
      .resolve(String(value).trim())
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

/** 副本标记：记录「这份副本是从哪个源包、哪个版本复制来的」。 */
function getRegisteredCopyMarkerPath(root = REGISTERED_COPY_ROOT) {
  return path.join(root, ".zh-cn-registered.txt");
}

function readRegisteredCopyMarker(root = REGISTERED_COPY_ROOT) {
  try {
    const lines = fs
      .readFileSync(getRegisteredCopyMarkerPath(root), "utf8")
      .split(/\r?\n/);
    return { sourceRoot: lines[0] || "", sourceVersion: lines[1] || "" };
  } catch {
    return null;
  }
}

/** 客户端读这个文件判断「已汉化」以及该用哪个 AUMID 启动。 */
function getRegisteredLocalizationRecordPath() {
  return path.join(getCodexHome(), "zh-cn-registered.json");
}

function readRegisteredLocalizationRecord() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getRegisteredLocalizationRecordPath(), "utf8"),
    );
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 准备「已注册的汉化副本」—— 新路线的核心。
 *
 * 复用判据很严：**副本已注册** 且 **标记里的源包路径与版本都和当前商店版一致**
 * 才跳过复制。否则按「移除旧包 → 重建目录 → 整包复制 → 改清单 → 写标记」重做。
 *
 * 注册和汉化分别由 `registerAppxCopy()` 与 `install()` 接着做。需要管理员的
 * 步骤若在非提权下失败，会抛 `[codex-zh-cn-need-admin]` / `[codex-zh-cn-need-devmode]` 信号，
 * 由客户端提权重跑 —— 那时复制结果会被复用，用户不会白等第二遍。
 */
function ensureRegisteredAppxCopy(installInfo, { skipStop = false } = {}) {
  localizationDiagnostic.step = "find_source";
  const copyApp = path.join(REGISTERED_COPY_ROOT, "app");
  const copyAsar = path.join(copyApp, "resources", "app.asar");
  const registered = queryRegisteredPackage();
  const marker = readRegisteredCopyMarker();

  // Honor the client's explicit original package. Only rediscover when the
  // selected installation is our localized copy or another non-original root.
  const selectedRoot = resolveAppxPackageRoot(installInfo.app);
  const selectedName =
    selectedRoot && readManifestIdentityField(selectedRoot, "Name");
  const storeInstall = [
    "OpenAI.Codex",
    "OpenAI.Codex_customer-install",
  ].includes(selectedName)
    ? installInfo
    : findWindowsAppsCodex();
  const sourceRoot = storeInstall
    ? resolveAppxPackageRoot(storeInstall.app)
    : null;
  const sourceVersion = readSourcePackageVersion(sourceRoot);
  const sourceIdentity = sourceRoot && readManifestIdentityField(sourceRoot, "Name");
  if (["OpenAI.Codex", "OpenAI.Codex_customer-install", "OpenAI.Codex.FMKJ"].includes(sourceIdentity)) localizationDiagnostic.packageIdentity = sourceIdentity;

  const copyOnDisk = Boolean(marker && fs.existsSync(copyAsar));
  // 复用条件：盘上有完整副本，且「商店版不在 ⇒ 只能用它」或「源路径与版本一致」。
  //   - 商店版被卸载：已有的汉化不该因此失效，照用；
  //   - 源版本没变：直接重打补丁，省掉那 1.9 GB 的复制；
  //   - ⚠️ **不要求「已注册」** —— 上一次流程可能在「复制完、注册前」被打断
  //     （2026-09-20 实测遇到过一次），这时应当跳过复制、只补做注册与汉化。
  const canReuse =
    copyOnDisk &&
    (!sourceRoot ||
      (sameWindowsPath(marker.sourceRoot, sourceRoot) &&
        marker.sourceVersion === sourceVersion));

  if (canReuse) {
    logOk(
      registered
        ? `汉化副本已就绪（${registered.version}），跳过复制。`
        : "汉化副本文件已就绪，跳过复制，继续完成注册。",
    );
    return {
      app: copyApp,
      resources: path.join(copyApp, "resources"),
      patchedRoot: REGISTERED_COPY_ROOT,
      sourceApp: sourceRoot ? storeInstall.app : marker.sourceRoot,
    };
  }

  if (!sourceRoot) {
    throw new Error(
      "没有找到 Microsoft Store 安装的 Codex —— 汉化版需要以商店原版为源复制一份。" +
        "请先从 Microsoft Store 安装 Codex 后再试。",
    );
  }

  // 前置条件先查，别让用户白等那 1.9 GB 的复制。
  // 开发者模式没开就顺手开掉（提权时能写进去）；写不进去才抛信号让客户端提权重跑。
  localizationDiagnostic.step = "developer_mode";
  ensureDeveloperMode();

  if (!skipStop) {
    ensureCodexStopped(3, INSTALL_STEP_TOTAL);
  }

  // 同名包不允许覆盖注册，重建前必须先移除旧的。
  if (registered) {
    logInfo(`移除旧的汉化副本包（${registered.version}）…`);
    runPowerShell(
      `Get-AppxPackage -Name '${REGISTERED_PACKAGE_NAME}' | Remove-AppxPackage -ErrorAction SilentlyContinue`,
      { timeout: 180000 },
    );
  }

  logInfo(`复制源: ${sourceRoot}`);
  logInfo(`复制到: ${REGISTERED_COPY_ROOT}`);
  progressLog(
    3,
    INSTALL_STEP_TOTAL,
    "正在复制 Codex 到用户目录（约 1.9 GB，请勿关闭窗口）…",
  );
  localizationDiagnostic.step = "copy_package";
  const seconds = runWithProgressHeartbeat("正在复制 Codex 文件", () =>
    copyStorePackage(sourceRoot, REGISTERED_COPY_ROOT),
  );

  localizationDiagnostic.step = "rewrite_manifest";
  patchRegisteredManifest(REGISTERED_COPY_ROOT);
  fs.mkdirSync(REGISTERED_COPY_ROOT, { recursive: true });
  fs.writeFileSync(
    getRegisteredCopyMarkerPath(),
    `${sourceRoot}\n${sourceVersion}\n`,
    "utf8",
  );
  logOk(`副本准备完成（复制耗时 ${seconds} 秒）: ${copyApp}`);

  return {
    app: copyApp,
    resources: path.join(copyApp, "resources"),
    patchedRoot: REGISTERED_COPY_ROOT,
    sourceApp: storeInstall.app,
  };
}

/** 跑一次 `Add-AppxPackage -Register`，返回 `{ok, detail}`（这一层不抛错）。 */
function attemptAppxRegister(manifestPath) {
  const script = [
    "try {",
    `  Add-AppxPackage -Register '${manifestPath}' -ErrorAction Stop`,
    '  Write-Output "REGISTER_OK"',
    "} catch {",
    '  Write-Output ("REGISTER_FAIL: " + $_.Exception.Message)',
    "}",
  ].join("\n");
  const result = runPowerShell(script, { timeout: 600000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (output.includes("REGISTER_OK")) return { ok: true, detail: "" };

  const detail =
    output.replace(/^.*REGISTER_FAIL:\s*/, "").trim() ||
    `退出码 ${result.status}`;
  return { ok: false, detail };
}

/** 把注册失败的详情翻译成客户端可识别的信号（需要提权 / 需要开发者模式）。 */
function reportRegisterBlockers(detail) {
  if (/0x80073D28|需要管理员|administrator|elevat/i.test(detail)) {
    process.stderr.write("[codex-zh-cn-need-admin] 注册汉化副本需要管理员权限\n");
  }
  if (/0x80073CFF|developer mode|开发人员模式|开发者模式/i.test(detail)) {
    process.stderr.write(
      "[codex-zh-cn-need-devmode] 注册汉化副本需要开启开发者模式\n",
    );
  }
}

/**
 * 注册（或重新注册）副本包。
 *
 * 先用**原清单**注册：健康机器上 `windows.firewallRules` 声明会一起登记，副本因此
 * 拿到 1455/1457、本地代理端口的入站预授权。只有这一步真被防火墙服务拒绝
 * （`0x800706D9`）时，才删掉声明重注册一次 —— 那一手是给网吧/精简镜像准备的，
 * 代价是丢这份预授权（详见 `scripts/localization-patches.mjs` 里的条件删说明）。
 *
 * `Add-AppxPackage -Register` 需要管理员（非提权报 `0x80073D28`），未开开发者
 * 模式时报 `0x80073CFF`。两种情况都给客户端可识别的信号，由它去提权 /
 * 征得用户同意后打开开关，而不是把英文错误码丢给用户。
 */
function registerAppxCopy() {
  localizationDiagnostic.step = "register_package";
  const manifestPath = path.join(REGISTERED_COPY_ROOT, "AppxManifest.xml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`副本清单缺失：${manifestPath}`);
  }

  let attempt = attemptAppxRegister(manifestPath);
  if (attempt.ok) {
    logOk(`汉化副本已注册为独立应用（${REGISTERED_PACKAGE_NAME}）。`);
    return queryRegisteredPackage();
  }

  if (!isFirewallRegistrationFailure(attempt.detail)) {
    reportRegisterBlockers(attempt.detail);
    throw new Error(`注册汉化副本失败：${attempt.detail}`);
  }

  // 防火墙服务拒绝了这次注册：删掉声明再来一次（条件删的唯一触发点）。
  logInfo("注册被系统的防火墙服务拒绝，正在移除副本清单里的防火墙声明后重试…");
  const text = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  const firewall = stripFirewallRulesExtensions(text);
  if (!firewall.removed) {
    throw new Error(
      `注册被系统的防火墙服务拒绝，而副本清单没有可移除的防火墙声明：${attempt.detail}`,
    );
  }
  fs.writeFileSync(manifestPath, firewall.manifest, "utf8");
  logOk(`已移除 ${firewall.removed} 处防火墙声明，重新注册…`);

  attempt = attemptAppxRegister(manifestPath);
  if (attempt.ok) {
    logOk(`汉化副本已注册为独立应用（${REGISTERED_PACKAGE_NAME}）。`);
    return queryRegisteredPackage();
  }
  reportRegisterBlockers(attempt.detail);
  throw new Error(`移除防火墙声明后注册仍未完成：${attempt.detail}`);
}

/**
 * 「已注册副本」路线的收尾。
 *
 * 写 `~/.codex/zh-cn-registered.json` —— 客户端读它判断「已汉化」以及
 * **该用哪个 AUMID 启动**：汉化版有自己独立的 AUMID，再也不能走官方
 * `OpenAI.Codex` 那个（那是商店版）。
 */
function finalizeRegisteredLocalization(sourceApp, copyApp) {
  const registered = queryRegisteredPackage();
  if (!registered) {
    throw new Error("注册后查询不到汉化副本的包信息，无法完成收尾。");
  }
  const record = {
    schemaVersion: 1,
    packageName: REGISTERED_PACKAGE_NAME,
    aumid: registered.aumid,
    packageVersion: registered.version,
    installRoot: REGISTERED_COPY_ROOT,
    appPath: copyApp,
    sourceApp,
    sourceVersion: readSourcePackageVersion(path.dirname(sourceApp)),
    createdAt: new Date().toISOString(),
  };
  const file = getRegisteredLocalizationRecordPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  logOk(`已记录汉化版启动信息：${registered.aumid}`);
  return record;
}

function resolvePatchTarget(installInfo, options = {}) {
  const { app, resources } = installInfo;

  // 卸载路径：存量机器上补丁可能打在「可写副本」里（0.1.89 及更早），
  // 必须回到那份副本才能把里面的文件还原回去，还原完再删副本。
  // 所以**只有卸载**时才去找旧副本。
  if (options.preferExistingCopy) {
    const legacyCopy = legacyPatchedCopyTarget(app);
    if (legacyCopy) return legacyCopy;
  }

  if (!fs.existsSync(path.join(resources, "app.asar"))) {
    throw new Error(
      "Store 版 app.asar 缺失或已损坏。请打开 Microsoft Store → Codex →「修复」或「重置」，完成后再运行汉化。",
    );
  }

  // ⚠️ 2026-09-20 二次改版：**复制副本 + 松散注册**取代「原地改写商店包」。
  //
  // 原地改写在 Win11 24H2 上根本做不到：系统从内核层面封死了 `WindowsApps` 的
  // 写盘 —— `takeown`/`icacls` 都能成功（退出码 0），紧接着写入仍然 EPERM，
  // 提权也一样（三条独立证据见 TRAPS.md）。于是改成**不动商店包**：
  // 复制到用户目录 → 改包身份 → 松散注册成独立应用 → 汉化那份副本。
  //
  // 「副本 exe 直接执行会被拒（APPMODEL_ERROR_NO_PACKAGE）」这个老结论**依然成立**，
  // 新路线靠「先注册、再按 AUMID 激活」绕开它
  // （实测：副本 8 个进程全部正常起来，主窗口正常）。
  // 便携版（非 MSIX/Store 安装）：没有「包身份」这回事 —— 直接原地改写它自己的
  // 文件即可，不需要复制、更不需要注册。
  //
  // 🔴 判据不能只看「有没有 `AppxManifest.xml`」（2026-09-22 客户机实测踩坑）：客户端的
  // 受管便携安装**根目录里也有一份清单**，只看清单会把便携版判成商店版，回头去找一个
  // 根本不存在的商店原版 —— 报「没有找到 Microsoft Store 安装的 Codex」；卸载（回滚）
  // 走同一套分类，也报同一句，客户端于是拼出「恢复汉化前状态失败…已保留事务记录」。
  // 分类逻辑与完整推理见 `decideLocalizationTargetKind`（纯函数、有单测覆盖）。
  const packageRoot = resolveAppxPackageRoot(app);
  const managedPortable =
    isManagedPortableInstall(app) || isManagedPortableInstall(packageRoot);
  const identity = packageRoot && readManifestIdentityField(packageRoot, "Name");
  if (["OpenAI.Codex", "OpenAI.Codex_customer-install", "OpenAI.Codex.FMKJ"].includes(identity)) localizationDiagnostic.packageIdentity = identity;
  localizationDiagnostic.installKind = managedPortable ? "portable" : "unmanaged";
  const kind = decideLocalizationTargetKind({
    managedPortable,
    // 受管便携版已经定性，就不必再去系统里查一遍包身份（省一次 PowerShell 往返）。
    registeredAsStorePackage:
      !managedPortable && isRegisteredPackageRoot(packageRoot),
  });

  if (kind === "in-place") {
    logInfo(
      managedPortable
        ? "检测到受管便携安装，按便携版处理：原地写入。"
        : "未检测到已注册的 AppX 包身份，按便携版处理：原地写入。",
    );
    return {
      app,
      resources,
      mode: "in-place",
      sourceApp: app,
      patchedRoot: null,
    };
  }

  localizationDiagnostic.installKind = "registered";
  return {
    ...ensureRegisteredAppxCopy(installInfo, { skipStop: options.skipStop }),
    mode: "store-register",
  };
}

/**
 * 旧的「可写副本」汉化目标（`~/.codex/zh-cn-patched/<hash>/app`）。
 *
 * 仅供卸载存量机器上的旧补丁使用；`install()` 已不再走这条路。
 * 返回 null 表示这台机器上没有可用的旧副本。
 */
function legacyPatchedCopyTarget(app) {
  if (!isWindowsAppsInstall(app)) return null;
  const patchedRoot = getPatchedAppRoot(app);
  const patchedApp = path.join(patchedRoot, "app");
  const patchedAsar = path.join(patchedApp, "resources", "app.asar");
  if (readPatchedAppMarker(patchedRoot) !== app) return null;
  if (!fs.existsSync(patchedAsar)) return null;
  return {
    app: patchedApp,
    resources: path.join(patchedApp, "resources"),
    mode: "store-copy",
    sourceApp: app,
    patchedRoot,
  };
}

/**
 * 复制 1.9 GB 之前先做一次**只读**格式预检。
 *
 * 2026-09-19 实测：新版 Codex（26.915）改掉了 zh-CN bundle 的导出结构，补丁要等到
 * 「副本复制完成、asar 已经写了一半」才报「无法定位 zh-CN bundle 导出位置」——
 * 用户白等 2–5 分钟，磁盘上还留下一个必须靠 uninstall 回滚的半成品副本。
 * 这里把**同一个判据**提前到复制之前：格式对不上就直接失败，一个字节都不复制。
 *
 * 判据刻意与 `patchZhBundle` 保持一致：只有「确实需要补词条」且「找不到插入点」
 * 才算不兼容 —— 免得对一份本来就齐全的 bundle 误报。
 */
function assertSourceAsarPatchable(installInfo, nativeMenu) {
  const sourceAsar = path.join(installInfo.resources, "app.asar");
  if (!fs.existsSync(sourceAsar)) {
    throw new Error(
      "Store 版 app.asar 缺失或已损坏。请打开 Microsoft Store → Codex →「修复」或「重置」，完成后再运行汉化。",
    );
  }
  const bytes = fs.readFileSync(sourceAsar);
  const parsed = readAsarHeader(bytes, sourceAsar);
  let mainBundle = null;
  let zhBundle = null;
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (
      !mainBundle &&
      filePath.includes(".vite/build/main-") &&
      filePath.endsWith(".js")
    ) {
      mainBundle = filePath;
    }
    if (
      !zhBundle &&
      filePath.includes("webview/assets/zh-CN-") &&
      filePath.endsWith(".js")
    ) {
      zhBundle = filePath;
    }
    if (mainBundle && zhBundle) break;
  }
  if (!mainBundle) {
    throw new Error(
      "未在 app.asar 中找到 main bundle（当前 Codex 资源格式可能已更新）；已放弃汉化，未复制任何文件。",
    );
  }
  if (!zhBundle) {
    // 没有独立 zh-CN bundle 的版本本来就走运行时兜底，不算不兼容。
    logInfo("当前 Codex 未包含独立的 zh-CN bundle，将使用运行时动态汉化兜底。");
    return;
  }
  const entry = getAsarFileEntry(parsed.header, zhBundle);
  const offset = 8 + parsed.headerSize + Number(entry.offset);
  const text = bytes
    .subarray(offset, offset + Number(entry.size))
    .toString("utf8");
  const menuTitleMap = Object.fromEntries(
    Object.entries(nativeMenu).filter(([key]) =>
      key.startsWith("codex.commandMenuTitle."),
    ),
  );
  const missing = Object.entries(menuTitleMap).filter(
    ([key]) => !text.includes(`"${key}":`),
  );
  if (missing.length === 0) {
    logOk("Codex 资源格式检查通过（zh-CN 词条已齐全）。");
    return;
  }
  if (locateZhBundleInsertAt(text) < 0) {
    throw new Error(
      "无法定位 zh-CN bundle 导出位置（当前 Codex 资源格式可能已更新）；已放弃汉化，未复制任何文件。",
    );
  }
  logOk("Codex 资源格式检查通过。");
}

function writePatchedLauncher(patchedApp) {
  if (!findPatchedCodexExe(patchedApp)) {
    throw new Error(
      `副本中未找到 ${CODEX_EXE_CANDIDATES.join(" / ")}，无法创建启动脚本。`,
    );
  }

  const launchersDir = path.join(projectRoot, "launchers");
  const templateBat = path.join(launchersDir, "Codex 汉化版.bat");
  const templateBatAscii = path.join(launchersDir, "launch-codex-zh-cn.bat");
  const templatePs1 = path.join(launchersDir, "launch-codex-zh-cn.ps1");
  if (
    !fs.existsSync(templateBat) ||
    !fs.existsSync(templateBatAscii) ||
    !fs.existsSync(templatePs1)
  ) {
    throw new Error(
      "缺少 launchers/Codex 汉化版.bat、launch-codex-zh-cn.bat 或 launch-codex-zh-cn.ps1 模板文件。",
    );
  }

  const {
    bat: installBat,
    batAscii: installBatAscii,
    ps1: installPs1,
    legacyVbs,
  } = getInstallLauncherPaths();
  removeStaleLaunchers();
  fs.copyFileSync(templateBat, installBat);
  fs.copyFileSync(templateBatAscii, installBatAscii);
  fs.copyFileSync(templatePs1, installPs1);
  if (fs.existsSync(legacyVbs)) {
    try {
      fs.unlinkSync(legacyVbs);
    } catch {
      logInfo(`请手动删除旧版 VBS 启动脚本: ${legacyVbs}`);
    }
  }

  logOk(`汉化版启动入口: ${installBat}`);
  logOk(`备用启动入口: ${installBatAscii}`);
  logOk(`PowerShell 启动脚本: ${installPs1}`);
  console.log(
    `[info] 请在本目录双击「Codex 汉化版.bat」启动（与 install-windows.bat 同目录）；勿用 Store 原版快捷方式。`,
  );
}

function getPluginBackupRoot(codexHome) {
  return path.join(codexHome, ".zh-cn-backups", "latest");
}

function findBundledPluginJsonFiles(codexHome, extraRoots = []) {
  const results = new Set();
  const roots = [
    path.join(codexHome, "plugins", "cache", "openai-bundled"),
    path.join(codexHome, "plugins", "cache", "openai-primary-runtime"),
    path.join(
      codexHome,
      ".tmp",
      "bundled-marketplaces",
      "openai-bundled",
      "plugins",
    ),
    ...extraRoots,
  ];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".codex-plugin") {
          const pluginJson = path.join(next, "plugin.json");
          if (fs.existsSync(pluginJson)) results.add(pluginJson);
          continue;
        }
        walk(next);
      }
    }
  }

  for (const root of roots) walk(root);
  return [...results];
}

function backupPluginJson(pluginJsonPath, backupRoot, codexHome) {
  const rel = path.relative(codexHome, pluginJsonPath);
  const target = path.join(backupRoot, rel);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(pluginJsonPath, target);
  console.log(`[backup] ${rel}`);
}

function patchMarketplaceJson(marketplaceJsonPath, translations) {
  const marketplace = JSON.parse(fs.readFileSync(marketplaceJsonPath, "utf8"));
  const patch = translations["__marketplace__openai-bundled"];
  if (!patch?.displayName || !marketplace.interface) return false;
  if (marketplace.interface.displayName === patch.displayName) return false;
  marketplace.interface.displayName = patch.displayName;
  fs.writeFileSync(
    marketplaceJsonPath,
    `${JSON.stringify(marketplace, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function findAppResourcePluginFiles(appDir) {
  const pluginsRoot = path.join(appDir, "resources", "plugins");
  const results = {
    pluginJson: [],
    marketplaceJson: [],
  };
  if (!fs.existsSync(pluginsRoot)) return results;

  const marketplaceJson = path.join(
    pluginsRoot,
    "openai-bundled",
    ".agents",
    "plugins",
    "marketplace.json",
  );
  if (fs.existsSync(marketplaceJson)) {
    results.marketplaceJson.push(marketplaceJson);
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".codex-plugin") {
          const pluginJson = path.join(next, "plugin.json");
          if (fs.existsSync(pluginJson)) results.pluginJson.push(pluginJson);
          continue;
        }
        walk(next);
      }
    }
  }
  walk(pluginsRoot);
  return results;
}

function patchAppResourcePlugins(appDir, translations) {
  const { pluginJson, marketplaceJson } = findAppResourcePluginFiles(appDir);
  let count = 0;
  for (const filePath of marketplaceJson) {
    if (patchMarketplaceJson(filePath, translations)) {
      count += 1;
      console.log(`[ok] 已汉化市场 ${path.relative(appDir, filePath)}`);
    }
  }
  for (const filePath of pluginJson) {
    if (patchPluginInterface(filePath, translations)) {
      count += 1;
      console.log(`[ok] 已汉化应用内插件 ${path.relative(appDir, filePath)}`);
    }
  }
  return count;
}

function patchPluginInterface(pluginJsonPath, translations) {
  const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  const patch = translations[plugin.name];
  if (!patch || !plugin.interface) return false;

  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      if (JSON.stringify(plugin.interface[key]) !== JSON.stringify(value)) {
        plugin.interface[key] = value;
        changed = true;
      }
      continue;
    }
    if (typeof value === "string" && plugin.interface[key] !== value) {
      plugin.interface[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;

  fs.writeFileSync(
    pluginJsonPath,
    `${JSON.stringify(plugin, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function patchBundledPlugins(translations, options = {}) {
  const codexHome = getCodexHome();
  const backupRoot = getPluginBackupRoot(codexHome);
  const pluginJsonPaths = findBundledPluginJsonFiles(
    codexHome,
    options.extraPluginRoots || [],
  );

  let count = 0;
  if (options.appDir) {
    count += patchAppResourcePlugins(options.appDir, translations);
  }

  if (pluginJsonPaths.length === 0 && count === 0) {
    console.log(
      "[warn] 未找到内置插件 plugin.json，请先启动一次 Codex 后再安装。",
    );
    return count;
  }

  for (const pluginJsonPath of pluginJsonPaths) {
    backupPluginJson(pluginJsonPath, backupRoot, codexHome);
    if (patchPluginInterface(pluginJsonPath, translations)) {
      count += 1;
      console.log(
        `[ok] 已汉化插件 ${path.relative(codexHome, pluginJsonPath)}`,
      );
    }
  }
  return count;
}

function restoreBundledPlugins() {
  const codexHome = getCodexHome();
  const backupRoot = getPluginBackupRoot(codexHome);
  if (!fs.existsSync(backupRoot)) return 0;

  let count = 0;
  function walk(dir, rel = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const nextAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextAbs, nextRel);
        continue;
      }
      if (entry.name !== "plugin.json") continue;
      const target = path.join(codexHome, nextRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(nextAbs, target);
      console.log(`[restore] ${nextRel}`);
      count += 1;
    }
  }

  walk(backupRoot);
  return count;
}

function install(options) {
  console.log("[progress] ========== 开始安装 Codex 简体中文汉化 ==========");
  localizationDiagnostic.step = "resource_preflight";
  const toolResources = preflightToolResources();
  // 资源预检之后、任何写盘之前，再确认语言包运行时在位。
  // 缺 main.cjs / preload 时直接失败，避免装出「提示成功但不汉化」的状态。
  localizationDiagnostic.step = "runtime_preflight";
  assertRuntimePresent(RUNTIME_DIR);
  logOk(`语言包运行时: ${RUNTIME_DIR}`);
  writeRuntimePathHint(RUNTIME_DIR);
  clearRuntimeVerification();
  localizationDiagnostic.step = "stop_processes";
  progressLog(1, INSTALL_STEP_TOTAL, "关闭 Codex 及相关进程…");
  ensureCodexStopped(1, INSTALL_STEP_TOTAL);

  localizationDiagnostic.step = "find_install";
  progressLog(2, INSTALL_STEP_TOTAL, "查找 Codex 安装目录…");
  const installInfo = findCodexInstall(options.codexPath);
  logOk(`已找到 Codex: ${installInfo.app}`);

  // ⚠️ 格式预检必须排在 `resolvePatchTarget` **之前** —— 后者会触发整份副本的复制。
  localizationDiagnostic.step = "resource_preflight";
  progressLog(3, INSTALL_STEP_TOTAL, "检查 Codex 资源格式…");
  const nativeMenu = toolResources["native-menu-zh-CN.json"];
  assertSourceAsarPatchable(installInfo, nativeMenu);

  const target = resolvePatchTarget(installInfo, { skipStop: true });
  const { app, resources, mode, sourceApp, patchedRoot } = target;
  const asarPath = path.join(resources, "app.asar");
  const backupRoot = getInstallBackupRoot(app);

  if (mode === "store-register") {
    logInfo(`商店源目录: ${sourceApp}`);
  }
  localizationDiagnostic.step = "backup";
  progressLog(
    4,
    INSTALL_STEP_TOTAL,
    mode === "store-register" ? "准备汉化副本应用…" : "备份原始文件…",
  );
  logInfo(`补丁目录: ${app}`);

  if (mode === "store-register") {
    // 注册排在汉化**之前**（与 2026-09-20 实测顺序一致）。这样做的好处是
    // 「已注册、但汉化还没落地」是一个可以直接重跑的干净状态 —— 注册本身只
    // 登记清单、不校验文件哈希；真要重跑时复制结果会被复用，用户不必再等一遍。
    //
    // ⚠️ 已经注册过就**别再注册**：`Add-AppxPackage -Register` 要管理员，
    // 而「重新打补丁到现有副本」这件事根本不需要 —— 这正是 `status` 里
    // `requiresAdmin = storeRoute && !registered` 表达的意思。
    // 照旧无条件重注册的话，用户每次点「一键汉化」都要白弹一次 UAC。
    // （不需要担心清单过期：清单只在**新建副本**时被改写，而新建副本那一刻
    //   必然是未注册状态，走的还是注册分支。）
    const existing = queryRegisteredPackage();
    if (
      existing &&
      sameWindowsPath(existing.installLocation, REGISTERED_COPY_ROOT)
    ) {
      logOk(`汉化副本已注册（${existing.version}），跳过重新注册。`);
    } else {
      registerAppxCopy();
    }
  } else {
    // 存量机器上的原地汉化：先拿到写权限、再备份，失败了好还原。
    // 副本路线不需要备份 —— 它本来就是从商店包复制出来的，随时能重建。
    if (mode === "in-place") {
      logInfo(`备份目录: ${backupRoot}`);
      prepareInstallWriteAccess(app, resources, asarPath);
      assertInstallWritable(asarPath);
    }
    localizationDiagnostic.step = "backup";
    backupFile(asarPath, backupRoot);
    backupFile(path.join(app, "ChatGPT.exe"), backupRoot);
    backupFile(path.join(app, "Codex.exe"), backupRoot);
    backupFile(path.join(app, "codex.exe"), backupRoot);
    logOk("备份完成。");
  }

  localizationDiagnostic.step = "patch_asar";
  progressLog(5, INSTALL_STEP_TOTAL, "写入 app.asar 汉化补丁…");
  const hardcoded = toolResources["menu-hardcoded-zh-CN.json"];

  replaceStandaloneAsarFile(
    asarPath,
    "native-menu-locales/zh-CN.json",
    Buffer.from(JSON.stringify(nativeMenu), "utf8"),
  );
  console.log("[ok] 已更新 native-menu-locales/zh-CN.json");

  const parsed = readAsarHeader(fs.readFileSync(asarPath), asarPath);
  const headerSize = parsed.headerSize;
  let mainAsarPath = null;
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (filePath.includes(".vite/build/main-") && filePath.endsWith(".js")) {
      mainAsarPath = filePath;
      break;
    }
  }
  if (!mainAsarPath) throw new Error("未在 app.asar 中找到 main bundle。");

  const data = fs.readFileSync(asarPath);
  const entry = getAsarFileEntry(parsed.header, mainAsarPath);
  const offset = 8 + headerSize + Number(entry.offset);
  const mainContent = data.subarray(offset, offset + Number(entry.size));
  const mainPatched = patchMainBundle(mainContent, hardcoded);
  const rolePatched = patchRoleMenus(mainPatched.buffer);
  const runtimePatched = injectRuntimeBootstrap(rolePatched.buffer);
  replaceAsarFileContent(asarPath, mainAsarPath, runtimePatched.buffer);
  console.log(
    `[ok] 已汉化主进程菜单：硬编码 ${mainPatched.count} 处，结构/角色 ${rolePatched.count} 处 (${mainAsarPath})`,
  );

  let zhAsarPath = null;
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (
      filePath.includes("webview/assets/zh-CN-") &&
      filePath.endsWith(".js")
    ) {
      zhAsarPath = filePath;
      break;
    }
  }
  if (zhAsarPath) {
    const parsed3 = readAsarHeader(fs.readFileSync(asarPath), asarPath);
    const entry2 = getAsarFileEntry(parsed3.header, zhAsarPath);
    const offset2 = 8 + parsed3.headerSize + Number(entry2.offset);
    const zhContent = fs
      .readFileSync(asarPath)
      .subarray(offset2, offset2 + Number(entry2.size));
    const menuTitleMap = Object.fromEntries(
      Object.entries(nativeMenu).filter(([k]) =>
        k.startsWith("codex.commandMenuTitle."),
      ),
    );
    const zhPatched = patchZhBundle(zhContent, menuTitleMap);
    if (zhPatched.count > 0) {
      replaceAsarFileContent(asarPath, zhAsarPath, zhPatched.buffer);
      console.log(
        `[ok] 已补充 webview 中文词条 ${zhPatched.count} 条 (${zhAsarPath})`,
      );
    }
  }

  localizationDiagnostic.step = "patch_webview";
  progressLog(6, INSTALL_STEP_TOTAL, "汉化 webview 与界面文案…");
  const webviewResult = patchWebviewBundles(asarPath);
  if (webviewResult.count > 0) {
    logOk(`已补丁 webview 文案 ${webviewResult.count} 个文件`);
  }
  if (webviewResult.officialI18nGateFound) {
    logOk(
      webviewResult.officialI18nGatePatched
        ? "已启用 Codex 官方简体中文资源入口"
        : "Codex 官方简体中文资源入口已经启用",
    );
  } else {
    logInfo("当前 Codex 未匹配官方 i18n gate，保留运行时动态汉化兜底。");
  }

  // 副本是松散注册的，Store 不认它 ⇒ 内建更新器只会弹「去商店更新」，用户点了
  // 装回/更新的是官方英文版。把那两句文案改成引导回客户端点「一键汉化」。
  // 必须排在 `syncExeAsarIntegrity` **之前**（那是所有 asar 写入的收尾）。
  const updatePrompt = patchUpdatePromptBundles(
    asarPath,
    toolResources["update-prompt-zh-CN.json"],
  );
  if (updatePrompt.count > 0) {
    logOk(`已改写「去商店更新」提示 ${updatePrompt.replaced} 处`);
  } else {
    logInfo("未匹配到「去商店更新」提示，跳过（Codex 版本可能已变）。");
  }

  localizationDiagnostic.step = "locale_plugins";
  progressLog(7, INSTALL_STEP_TOTAL, "设置语言并汉化内置插件…");
  setCodexLocale();

  const bundledPlugins = toolResources["bundled-plugins-zh-CN.json"];
  const pluginCount = patchBundledPlugins(bundledPlugins, { appDir: app });
  if (pluginCount > 0) {
    logOk(`已汉化内置插件 metadata ${pluginCount} 处`);
  }

  console.log(`[codex-app] ${app}`);
  logOk(
    mode === "store-register"
      ? "汉化补丁已写入独立副本应用。"
      : "汉化补丁已写入。",
  );

  // 关键：必须放在所有 app.asar 写入完成之后。
  // asar 头部一变（哪怕只改一个字节），exe 里内嵌的完整性哈希就失效，
  // Electron 启动时会直接 FATAL 终止（表现为「提示汉化成功、打开还是英文/打不开」）。
  syncExeAsarIntegrity(app, asarPath);

  if (mode === "store-register") {
    // 写 `~/.codex/zh-cn-registered.json`：客户端读它判断「已汉化」，并据此改走
    // **副本自己的 AUMID** 启动 —— 再也不能走官方那个（那是商店版的位置）。
    finalizeRegisteredLocalization(sourceApp, app);
  } else {
    // 原地汉化的收尾：写 in-place 标记（客户端据此改走官方 AUMID 启动）、
    // 撕掉旧的「走副本」激活记录、回收旧版本留下的可写副本。
    finalizeInPlaceLocalization(app);
  }

  if (options.relaunch !== false) {
    localizationDiagnostic.step = "launch";
    progressLog(8, INSTALL_STEP_TOTAL, "重新启动 Codex…");
    startCodex(app, patchedRoot, mode);
  } else {
    logInfo("已跳过自动启动（使用了 --no-relaunch）。");
  }
  console.log("[progress] ========== 汉化安装完成 ==========");
  // 推荐位只放一行、只在这一刻出现（用户刚装成功、情绪最好）。
  // 不要加弹窗、不要要求注册、不要在失败路径上出现 —— 那是骚扰而不是推荐。
  if (process.env.CODEX_ZH_NO_PROMO !== "1") {
    logInfo(
      "同时管理多个 Codex 账号 / 一键装 Claude Code 和 WorkBuddy？→ https://app.fmkj.top/download?utm_source=installer&utm_medium=cli&utm_campaign=codex-zh-cn",
    );
  }
}

/**
 * 这份安装的版本号（**受管便携**口径）—— 客户端 `installed_version()` 对
 * `ManagedPortable` 读的就是 `.codex-managed` 的 `version`，这里必须同源，
 * 否则客户端 `in_place_localized()` 的第 ② 条对不上。
 */
function readManagedInstallVersion(app) {
  for (const dir of [app, app ? path.dirname(app) : null]) {
    if (!dir) continue;
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(dir, MANAGED_PORTABLE_MARKER), "utf8"),
      );
      if (
        metadata &&
        typeof metadata.version === "string" &&
        metadata.version
      ) {
        return metadata.version;
      }
    } catch {}
  }
  return null;
}

/**
 * 包清单（`AppxManifest.xml`）所在目录。
 *
 * 两种形态差一层，不能假定只有一种：
 *   · 注册包   ⇒ `app` 是 `<包根>/app`，清单在**父目录**；
 *   · 受管便携 ⇒ `flatten-v1` 把 `app/` 抹平到根，`app` **就是**包根、清单就在 `app` 里。
 */
function manifestRootFor(app) {
  if (!app) return null;
  if (fs.existsSync(path.join(app, "AppxManifest.xml"))) return app;
  const parent = path.dirname(app);
  return fs.existsSync(path.join(parent, "AppxManifest.xml")) ? parent : app;
}

/**
 * 原地汉化成功后的收尾：
 *  1. 写下 **in-place 标记**（`~/.codex/zh-cn-inplace.json`）—— 供安装器判断当前状态
 *     判断「已汉化」，并据此改走**官方 AUMID** 启动（不再执行任何副本 exe）；
 *  2. 撕掉「以后启动走副本」那张旧激活记录；
 *  3. 回收旧版本留下的可写副本目录（约 1.5–1.9 GB）；
 *  4. 清掉副本时代留下的 bat / ps1 / vbs 启动入口（见 `removeLegacyLaunchers`）。
 *
 * 标记里记的是 `app` 的绝对路径，而 Store 包的路径里带版本号
 * （`OpenAI.Codex_26.915.4065.0_x64__…`）⇒ Codex 一更新，路径就变，
 * 客户端据此自动判「补丁已失效」，不会把旧汉化当成新的。
 */
function finalizeInPlaceLocalization(app) {
  // 必须在删激活记录**之前**算出来：`getPatchedAppRoot` 会先读那张记录。
  const legacyRoot = isWindowsAppsInstall(app) ? getPatchedAppRoot(app) : null;

  // 🔴 写标记**不看安装形态**。老实现把它包在 `if (isWindowsAppsInstall(app))` 里，
  // 等于「只有商店版写标记」；便携版于是永远没有标记 ⇒ 客户端判「未汉化」⇒
  // `apply()` 后置校验失败 ⇒ **自动回滚把刚打好的补丁拆掉**
  // （2026-09-22 客户机实测，完整推理见 `buildInPlaceMarker` 的注释）。
  try {
    fs.mkdirSync(getCodexHome(), { recursive: true });
    fs.writeFileSync(
      getInPlaceMarkerFile(),
      `${JSON.stringify(
        buildInPlaceMarker({
          app,
          version: resolveInPlaceMarkerVersion({
            // 与客户端 `installed_version()` 逐字对齐：
            // 受管便携读 `.codex-managed`，注册包读清单 `Identity/@Version`。
            managedVersion: readManagedInstallVersion(app),
            manifestVersion: readSourcePackageVersion(manifestRootFor(app)),
          }),
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    logInfo(`已写入原地汉化标记: ${getInPlaceMarkerFile()}`);
  } catch (error) {
    console.log(`[warn] 写入原地汉化标记失败: ${error.message}`);
  }

  removeActivePatchedRootRecord();
  removeLegacyLaunchers();
  if (legacyRoot && fs.existsSync(legacyRoot)) {
    removePatchedCopy(legacyRoot);
  }
}

/**
 * 清掉副本时代留在**安装目录 / 桌面**上的启动入口
 * （`Codex 汉化版.bat`、`launch-codex-zh-cn.bat/.ps1`、`Codex 汉化版.vbs`）。
 *
 * 它们全都指向 `~/.codex/zh-cn-patched/<hash>/app/ChatGPT.exe` 那份**已经被
 * 回收的副本** —— 双击就是「该进程没有程序包标识符」。原地汉化后开始菜单里的
 * 官方入口本身就是简体中文，这些多余入口只会把人引到坑里。
 */
function removeLegacyLaunchers() {
  const { bat, batAscii, ps1, legacyVbs } = getInstallLauncherPaths();
  const names = [
    "Codex 汉化版.bat",
    "launch-codex-zh-cn.bat",
    "launch-codex-zh-cn.ps1",
    "Codex 汉化版.vbs",
  ];
  const targets = [bat, batAscii, ps1, legacyVbs].concat(
    names.map((name) => path.join(os.homedir(), "Desktop", name)),
  );
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.unlinkSync(target);
      logInfo(`已移除指向旧汉化副本的启动入口: ${target}`);
    } catch {
      logInfo(`请手动删除旧启动入口: ${target}`);
    }
  }
}

/** 原地汉化标记文件；删掉它等于告诉客户端「这台机器没有汉化」。 */
function getInPlaceMarkerFile() {
  return path.join(getCodexHome(), "zh-cn-inplace.json");
}

function removeInPlaceMarker() {
  const file = getInPlaceMarkerFile();
  if (!fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
    logInfo(`已清除原地汉化标记: ${file}`);
  } catch (error) {
    console.log(`[warn] 清除原地汉化标记失败: ${error.message}`);
  }
}

/**
 * 撕掉「以后启动走汉化副本」这张激活记录（`~/.codex/zh-cn-patched-active.txt`）。
 *
 * 安装器读它决定「打开 Codex」走不走副本。
 * 记录在、副本却已经回滚/失效，客户端就会去执行一份**从 AppX 包里拷出来的 exe** ——
 * 它脱离包身份，Windows 直接拒绝并弹「该进程没有程序包标识符」。
 */
function removeActivePatchedRootRecord() {
  const file = getActivePatchedRootFile();
  if (!fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
    logInfo(`已清除汉化激活记录: ${file}`);
  } catch (error) {
    console.log(
      `[warn] 清除汉化激活记录失败，请手动删除: ${file}（${error.message}）`,
    );
  }
}

/** 删掉可写副本目录（约 1.5–1.9 GB）。删不干净只提示，不抛错。 */
function removePatchedCopy(patchedRoot) {
  if (!patchedRoot || !fs.existsSync(patchedRoot)) return;
  try {
    removeDirectoryRobust(patchedRoot);
  } catch (error) {
    console.log(`[warn] 删除汉化副本失败: ${patchedRoot}（${error.message}）`);
    return;
  }
  if (fs.existsSync(patchedRoot)) {
    console.log(
      `[warn] 汉化副本目录未能完全删除（可能被占用）: ${patchedRoot}`,
    );
  } else {
    logInfo(`已删除汉化副本: ${patchedRoot}`);
  }
}

/**
 * 移除汉化版启动脚本 —— 它们同样指向那份副本。
 *
 * 直接委托 `removeLegacyLaunchers()`，与安装路径共用同一份清单：
 * 旧实现只清**安装目录**里的 bat/ps1，**桌面上**那份会留下来，
 * 点它就是「该进程没有程序包标识符」（隔离沙盒验证时实测到这条）。
 */
function removeLocalizationLaunchers() {
  removeLegacyLaunchers();
}

/**
 * 「已注册副本」路线的卸载。
 *
 * 与原地汉化完全不同：商店包**从头到尾没被动过**，所以没有「还原文件」这件事 ——
 * 注销我们那个独立包、删掉副本目录、清掉记录，就等于回到汉化前。
 *
 * 返回 true 表示确实走了这条路，调用方据此提前结束。
 */
function removeRegisteredLocalization() {
  const recordPath = getRegisteredLocalizationRecordPath();
  const registered = queryRegisteredPackage();
  if (!registered && !fs.existsSync(recordPath)) return false;
  localizationDiagnostic.installKind = "registered";
  localizationDiagnostic.packageIdentity = "OpenAI.Codex.FMKJ";

  if (registered) {
    console.log(`[info] 正在注销汉化副本应用（${registered.version}）…`);
    runPowerShell(
      `Get-AppxPackage -Name '${REGISTERED_PACKAGE_NAME}' | Remove-AppxPackage -ErrorAction SilentlyContinue`,
      { timeout: 300000 },
    );
    const still = queryRegisteredPackage();
    if (still) {
      // 注销注册版应用需要管理员：抛信号让客户端提权重跑，
      // 而不是把「拒绝访问」这种话原样丢给用户。
      process.stderr.write("[codex-zh-cn-need-admin] 注销汉化副本需要管理员权限\n");
      throw new Error(
        `注销汉化副本应用失败（仍存在 ${still.version}）。请以管理员身份重试。`,
      );
    }
    console.log("[ok] 汉化副本应用已注销。");
  }

  removeDirectoryRobust(REGISTERED_COPY_ROOT);
  removeLocalizationLaunchers();
  // `~/.codex/config.toml` 是官方版和副本**共用**的，汉化时写进去的
  // `localeOverride = "zh-CN"` 必须一起还原 —— 否则用户点了「恢复英文」，
  // 打开官方版却被按中文 locale 加载（官方那套 zh-CN 词条不全，
  // 会看到半中半英或 "Failed to load locale messages"），跟按钮说的不是一回事。
  restoreCodexLocale();
  try {
    fs.unlinkSync(recordPath);
  } catch {}
  console.log("[ok] 汉化副本目录与记录已清理，Codex 回到商店原版。");
  return true;
}

function uninstall(options) {
  localizationDiagnostic.step = "restore";
  ensureCodexStopped();

  // 新路线优先：副本是独立应用，卸载 = 注销 + 删目录，一个字节都不用还原。
  localizationDiagnostic.step = "restore";
  if (removeRegisteredLocalization()) return;
  const installInfo = findCodexInstall(options.codexPath);
  const target = resolvePatchTarget(installInfo, { preferExistingCopy: true });
  const { app, resources, mode, patchedRoot } = target;
  const asarPath = path.join(resources, "app.asar");
  const backupRoot = resolveBackupRoot(app, resources);
  if (mode === "in-place") {
    prepareInstallWriteAccess(app, resources, asarPath);
  }

  // 先恢复备份（含 ChatGPT.exe / Codex.exe），再按最终落盘的 app.asar 对齐哈希。
  // 顺序不能反：若先同步哈希、后恢复 exe 备份，恢复出来的旧 exe 会与 asar 不匹配。
  localizationDiagnostic.step = "restore";
  restoreBackup(backupRoot, resources, "app.asar");
  for (const exeName of CODEX_EXE_CANDIDATES) {
    restoreBackup(backupRoot, app, exeName);
  }
  syncExeAsarIntegrity(app, asarPath);
  restoreCodexLocale();
  const restoredPlugins = restoreBundledPlugins();
  if (restoredPlugins > 0) {
    console.log(`[ok] 已恢复 ${restoredPlugins} 个插件 metadata 文件`);
  }
  console.log("[ok] 已恢复原样。");

  // ⚠️ 回滚必须**彻底**：把「以后启动走副本」那张纸条一起撕掉。
  // 少这一步会留下一个很隐蔽的坏状态（2026-09-19 梦可实测）：
  //   汉化失败 → 上面已经把副本里的文件都还原了，但激活记录还在，
  //   客户端按记录继续启动那份从 AppX 拷出来的 exe ⇒ 弹
  //   「该进程没有程序包标识符」，Codex 从此再也打不开。
  // 顺序放在恢复之后：`resolvePatchTarget` 要先按旧记录找到副本，才能还原里面的文件。
  removeActivePatchedRootRecord();
  removeInPlaceMarker();
  removePatchedCopy(patchedRoot);
  removeLocalizationLaunchers();
  removeRuntimePathHint();
}

function isCodexRunning() {
  // Read-only status may report unknown; install/uninstall use the strict
  // listRunningCodexProcesses check and must stop on detection failures.
  try {
    return listRunningCodexProcesses().length > 0;
  } catch {
    return null;
  }
}

/**
 * 主窗口菜单栏的中文默认值。跨版本最稳的判据：
 * 英文版是 windowsMenuBar.file/…=`File`/`Edit`/`View`/`Help`，
 * 汉化后变成 `文件`/`编辑`/`视图`/`帮助`。
 *
 * 必须锚定 `messageId:`（菜单构造处），不能只认 `windowsMenuBar.x`,defaultMessage:`，
 * 因为 i18n 词条目录里还有一份 `id:`windowsMenuBar.x`,defaultMessage:`File``，
 * 那份默认值本来就该是英文、也不会被补丁改写，不然会永远误判成「没汉化」。
 * （旧版还有 label:`文件` 这种字面量形式，用 legacy 分支兜住。）
 */
const WINDOWS_MENU_DEFAULT_RE =
  /messageId:`windowsMenuBar\.(\w+)`,defaultMessage:`([^`]*)`/g;
const CJK_RE = /[\u4e00-\u9fff]/;
const MENU_KEYS = ["file", "edit", "view", "help"];
const isMainBundle = (filePath) =>
  /^\.vite\/build\/main-[^/]+\.js$/.test(filePath);

function isAsarLocalized(asarPath) {
  try {
    for (const entry of readAsarEntries(asarPath, isMainBundle)) {
      const content = entry.content.toString("utf8");
      BROKEN_EDIT_MENU_RE.lastIndex = 0;
      if (BROKEN_EDIT_MENU_RE.test(content)) return false;

      const byKey = new Map();
      WINDOWS_MENU_DEFAULT_RE.lastIndex = 0;
      let match;
      while ((match = WINDOWS_MENU_DEFAULT_RE.exec(content)) !== null) {
        if (!byKey.has(match[1])) byKey.set(match[1], match[2]);
      }
      const menuLocalized = MENU_KEYS.every(
        (key) => byKey.has(key) && CJK_RE.test(byKey.get(key)),
      );

      const legacyLocalized =
        byKey.size === 0 &&
        content.includes("label:`文件`") &&
        content.includes("label:`编辑`");

      return menuLocalized || legacyLocalized;
    }
    return false;
  } catch {
    return false;
  }
}

function isRuntimeLocalizationInstalled(asarPath) {
  try {
    for (const entry of readAsarEntries(asarPath, isMainBundle)) {
      return hasRuntimeBootstrap(entry.content.toString("utf8"));
    }
    return false;
  } catch {
    return false;
  }
}

function isOfficialI18nGatePatched(asarPath) {
  try {
    for (const entry of readAsarEntries(asarPath, (filePath) =>
      /^webview\/assets\/[^/]+\.js$/.test(filePath),
    )) {
      if (hasOfficialI18nGatePatch(entry.content.toString("utf8"))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 「去商店更新」提示是否已经改成我们的中文引导。
 *
 * 用文件句柄按偏移只读 `.vite/build/` 下的包，避免整份读 app.asar。
 */
function isUpdatePromptLocalized(asarPath, translations) {
  const target = translations?.replacements?.[0]?.[1];
  if (!target) return false;
  let handle;
  try {
    handle = fs.openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    if (fs.readSync(handle, head, 0, 16, 0) < 16) return false;
    const headerSize = head.readUInt32LE(4);
    if (headerSize <= 0) return false;
    const prefix = Buffer.alloc(8 + headerSize);
    fs.readSync(handle, prefix, 0, prefix.length, 0);
    const parsed = readAsarHeader(prefix, asarPath);
    for (const [filePath] of walkAsarFiles(parsed.header)) {
      if (!filePath.includes(".vite/build/") || !filePath.endsWith(".js"))
        continue;
      const entry = getAsarFileEntry(parsed.header, filePath);
      const size = Number(entry?.size ?? 0);
      if (size <= 0) continue;
      const body = Buffer.alloc(size);
      fs.readSync(
        handle,
        body,
        0,
        size,
        8 + parsed.headerSize + Number(entry.offset),
      );
      if (body.toString("utf8").includes(target)) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function getLocaleOverride() {
  const configPath = path.join(getCodexHome(), "config.toml");
  if (!fs.existsSync(configPath)) return null;
  const match = fs
    .readFileSync(configPath, "utf8")
    .match(/localeOverride\s*=\s*"([^"]*)"/);
  return match ? match[1] : null;
}

function getPluginLocalizationSummary(translations) {
  const pluginJsonPaths = findBundledPluginJsonFiles(getCodexHome());
  let localized = 0;
  let total = 0;
  const details = [];

  for (const pluginJsonPath of pluginJsonPaths) {
    const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
    const expected = translations[plugin.name];
    if (!expected || !plugin.interface) continue;
    total += 1;
    const ok = expected.displayName
      ? plugin.interface.displayName === expected.displayName
      : true;
    if (ok) localized += 1;
    details.push({
      name: plugin.name,
      path: path.relative(getCodexHome(), pluginJsonPath),
      localized: ok,
      displayName: plugin.interface.displayName || "",
    });
  }

  return { localized, total, details };
}

function getRuntimeStatusPath() {
  // 开源版：状态文件放在 `~/.codex/`，不再写到客户端私有目录。
  return resolveRuntimeStatusPath(getCodexHome());
}

function clearRuntimeVerification() {
  try {
    fs.rmSync(getRuntimeStatusPath(), { force: true });
  } catch {}
}

function getRuntimeVerification() {
  try {
    const value = JSON.parse(fs.readFileSync(getRuntimeStatusPath(), "utf8"));
    const translated = Number(value.translated) || 0;
    const chineseVisible = Number(value.chineseVisible) || 0;
    const verified =
      value.schema === 1 &&
      value.runtimeLoaded === true &&
      value.preloadInjected === true &&
      (translated > 0 || chineseVisible > 0);
    return { verified, translated, chineseVisible };
  } catch {
    return { verified: false, translated: 0, chineseVisible: 0 };
  }
}

function buildStatusReport(options) {
  const translations = loadJson("bundled-plugins-zh-CN.json");
  const report = {
    ok: true,
    nodeVersion: process.version,
    nodeOk: true,
    codexPath: null,
    codexFound: false,
    codexRunning: isCodexRunning(),
    asarPath: null,
    asarBackup: false,
    asarLocalized: false,
    runtimeLocalized: false,
    officialI18nGatePatched: false,
    // 「去商店更新」提示是否已经改写成引导回客户端「一键汉化」。
    updatePromptLocalized: false,
    runtimeVerified: false,
    runtimeTranslatedCount: 0,
    runtimeChineseVisibleCount: 0,
    exeBackup: false,
    localeOverride: getLocaleOverride(),
    localeZhCn: false,
    pluginsLocalized: 0,
    pluginsTotal: 0,
    plugins: [],
    patchInstalled: false,
    readyToInstall: true,
    // ── 新路线（复制副本 + 松散注册）相关字段，客户端据以决定要不要提权 ──
    localizationMode: null,
    // 排障用的一眼可辨形态：managed-portable / store / unmanaged。
    // （排障时先看这个字段：便携版被当成商店版的现场，一眼就能分清。）
    installKind: null,
    registeredCopy: null,
    developerMode: false,
    requiresAdmin: true,
    messages: [],
  };

  try {
    const installInfo = findCodexInstall(options.codexPath);
    report.codexFound = true;
    report.codexPath = installInfo.app;
    report.asarPath = path.join(installInfo.resources, "app.asar");

    // 安装形态判定 —— 与 `resolvePatchTarget` 用**同一套判据**（同一个纯函数），
    // 别各判各的：两处判反了，用户就是「状态说要用管理员、真装起来却不用」（或反之）。
    //
    // 🔴 老注释「便携版没有 AppxManifest ⇒ 没有包身份这回事」对客户端的**受管便携
    // 安装是错的** —— 它根目录里就有清单（2026-09-22 客户机实测）。只看清单会把便携版
    // 报成商店版，后果有两件，都是无稽之谈却全都会显示给用户：
    //   ① `requiresAdmin` 为真 ⇒ 客户端为一个根本不需要提权的操作弹一次 UAC；
    //   ② 提示「要先开 Windows 开发者模式」—— 便携版压根不走注册那条路。
    const packageRoot = resolveAppxPackageRoot(installInfo.app);
    const managedPortable =
      isManagedPortableInstall(installInfo.app) ||
      isManagedPortableInstall(packageRoot);
    const targetKind = decideLocalizationTargetKind({
      managedPortable,
      // 受管便携已定性就不必再查包身份（省一次 PowerShell 往返）。
      registeredAsStorePackage:
        !managedPortable && isRegisteredPackageRoot(packageRoot),
    });
    const storeRoute = targetKind === "store-register";
    report.localizationMode = targetKind;
    report.installKind = managedPortable
      ? "managed-portable"
      : storeRoute
        ? "store"
        : "unmanaged";

    const registered = storeRoute ? queryRegisteredPackage() : null;
    report.registeredCopy = registered
      ? {
          aumid: registered.aumid,
          version: registered.version,
          installRoot: registered.installLocation,
        }
      : null;
    report.developerMode = storeRoute ? isDeveloperModeEnabled() : true;
    // 「重新打补丁到已有副本」不需要管理员；要复制/注册/注销就有一步必须提权。
    // 便携版原地写入的是用户目录下的文件，任何一步都不需要提权。
    report.requiresAdmin = storeRoute && !registered;

    // 检查目标：**已注册的副本**优先（新路线），其次存量可写副本，最后才是官方包。
    const registeredApp = path.join(REGISTERED_COPY_ROOT, "app");
    const registeredAsar = path.join(registeredApp, "resources", "app.asar");
    const patchTarget = (() => {
      if (registered && fs.existsSync(registeredAsar)) {
        return {
          app: registeredApp,
          resources: path.join(registeredApp, "resources"),
        };
      }
      if (isWindowsAppsInstall(installInfo.app)) {
        const patchedRoot = getPatchedAppRoot(installInfo.app);
        const patchedApp = path.join(patchedRoot, "app");
        const patchedAsar = path.join(patchedApp, "resources", "app.asar");
        if (
          readPatchedAppMarker(patchedRoot) === installInfo.app &&
          fs.existsSync(patchedAsar)
        ) {
          return {
            app: patchedApp,
            resources: path.join(patchedApp, "resources"),
          };
        }
      }
      return installInfo;
    })();
    const checkApp = patchTarget.app || installInfo.app;
    const checkResources = patchTarget.resources || installInfo.resources;
    const backupRoot = resolveBackupRoot(checkApp, checkResources);
    report.asarBackup = fs.existsSync(path.join(backupRoot, "app.asar"));
    report.exeBackup = CODEX_EXE_CANDIDATES.some((name) =>
      fs.existsSync(path.join(backupRoot, name)),
    );
    report.asarLocalized = isAsarLocalized(
      path.join(checkResources, "app.asar"),
    );
    report.runtimeLocalized = isRuntimeLocalizationInstalled(
      path.join(checkResources, "app.asar"),
    );
    report.officialI18nGatePatched = isOfficialI18nGatePatched(
      path.join(checkResources, "app.asar"),
    );
    report.updatePromptLocalized = isUpdatePromptLocalized(
      path.join(checkResources, "app.asar"),
      loadJson("update-prompt-zh-CN.json"),
    );
    if (storeRoute) {
      report.messages.push(
        registered
          ? `已安装汉化版：独立应用「${REGISTERED_DISPLAY_NAME}」，从开始菜单或客户端打开的都是它（商店原版不受影响）。`
          : "尚未安装汉化版：首次汉化会把 Codex 复制一份到用户目录并注册成独立应用（占用约 1.9 GB），需要开启 Windows 开发者模式。",
      );
      if (!report.developerMode) {
        report.messages.push(
          "Windows 开发者模式未开启，汉化前需要先在「设置 → 系统 → 开发者选项」中打开。",
        );
      }
    } else {
      // 便携版：把「就地改写、不提权、不碰商店版」说明白。
      // 客户机事故里用户看到的是「请先从 Microsoft Store 安装 Codex」，照着做只会装出
      // 一份**英文商店版**，反而把现场搞更乱 —— 这句话就是为了不再误导。
      report.messages.push(
        report.installKind === "managed-portable"
          ? "检测到客户端安装的便携版 Codex：汉化会就地写入这份安装，不需要管理员权限，也不会装商店版。"
          : "未检测到已注册的商店版 Codex：汉化会就地写入这份安装，不需要管理员权限。",
      );
    }
  } catch (error) {
    report.ok = false;
    report.readyToInstall = false;
    report.messages.push(error.message);
  }

  report.localeZhCn = report.localeOverride === "zh-CN";
  const runtimeVerification = getRuntimeVerification();
  report.runtimeVerified = runtimeVerification.verified;
  report.runtimeTranslatedCount = runtimeVerification.translated;
  report.runtimeChineseVisibleCount = runtimeVerification.chineseVisible;
  const pluginSummary = getPluginLocalizationSummary(translations);
  report.pluginsLocalized = pluginSummary.localized;
  report.pluginsTotal = pluginSummary.total;
  report.plugins = pluginSummary.details;
  report.patchInstalled =
    report.asarLocalized &&
    report.runtimeLocalized &&
    report.localeZhCn &&
    (report.pluginsTotal === 0 ||
      report.pluginsLocalized === report.pluginsTotal);

  if (report.codexRunning === null) {
    report.messages.push("无法确认 Codex 运行状态；安装前将重新检查。");
  } else if (report.codexRunning === false && report.codexFound) {
    report.messages.push("Codex 当前未运行，可以直接安装或重置。");
  } else if (report.codexRunning) {
    report.messages.push(
      "检测到 Codex 正在运行：安装汉化时会先自动关闭，完成后自动重启。",
    );
  }

  if (report.patchInstalled) {
    // ⚠️ 入口名字要跟着汉化形态走：已经不再是那个指向副本 exe 的
    // 「Codex 简体中文版」快捷方式了（那条路在 2026-09-20 就废弃了，
    // 并且 install 时会主动把旧快捷方式删掉）。
    const entry =
      report.localizationMode === "store-register"
        ? `开始菜单里的「${REGISTERED_DISPLAY_NAME}」`
        : "Codex";
    report.messages.push(
      report.runtimeVerified
        ? `当前判断：运行时已在真实页面完成汉化（累计命中 ${report.runtimeTranslatedCount} 处）。`
        : `汉化组件已安装；首次从${entry}启动后将完成真实页面验证。`,
    );
  } else if (report.codexFound) {
    report.messages.push(
      "当前判断：尚未完全汉化，或 Codex 更新后需要重新安装。",
    );
  }

  if (report.pluginsTotal === 0 && report.codexFound) {
    report.messages.push(
      "尚未找到内置插件缓存，首次汉化前建议先启动一次 Codex。",
    );
  }

  return report;
}

function printStatusReport(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log("[env] nodeVersion=" + report.nodeVersion);
  console.log("[env] codexFound=" + report.codexFound);
  console.log("[env] codexPath=" + (report.codexPath || ""));
  console.log("[env] codexRunning=" + report.codexRunning);
  // 排障先看这两行：形态判错（便携版被当成商店版）会让后面每一条都跟着错。
  console.log("[env] installKind=" + (report.installKind || ""));
  console.log("[env] localizationMode=" + (report.localizationMode || ""));
  console.log("[env] requiresAdmin=" + report.requiresAdmin);
  console.log("[env] asarLocalized=" + report.asarLocalized);
  console.log("[env] runtimeLocalized=" + report.runtimeLocalized);
  console.log(
    "[env] officialI18nGatePatched=" + report.officialI18nGatePatched,
  );
  console.log("[env] updatePromptLocalized=" + report.updatePromptLocalized);
  console.log("[env] runtimeVerified=" + report.runtimeVerified);
  console.log("[env] runtimeTranslatedCount=" + report.runtimeTranslatedCount);
  console.log(
    "[env] runtimeChineseVisibleCount=" + report.runtimeChineseVisibleCount,
  );
  console.log("[env] asarBackup=" + report.asarBackup);
  console.log("[env] exeBackup=" + report.exeBackup);
  console.log("[env] localeOverride=" + (report.localeOverride || ""));
  console.log("[env] localeZhCn=" + report.localeZhCn);
  console.log("[env] pluginsLocalized=" + report.pluginsLocalized);
  console.log("[env] pluginsTotal=" + report.pluginsTotal);
  console.log("[env] patchInstalled=" + report.patchInstalled);
  console.log("[env] readyToInstall=" + report.readyToInstall);
  for (const message of report.messages) {
    console.log("[env-msg] " + message);
  }
  for (const plugin of report.plugins) {
    console.log(
      `[env-plugin] ${plugin.name}|${plugin.localized}|${plugin.displayName}|${plugin.path}`,
    );
  }
}

function status(options) {
  const report = buildStatusReport(options);
  printStatusReport(report, options.json);
  if (!report.ok) process.exitCode = 2;
}

function parseArgs(argv) {
  const action = argv[2] || "install";
  let codexPath = null;
  let json = false;
  let relaunch = true;
  let logFile = null;
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--codex-path" && argv[i + 1]) {
      codexPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--log-file" && argv[i + 1]) {
      logFile = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--json") {
      json = true;
    } else if (argv[i] === "--no-relaunch") {
      relaunch = false;
    }
  }
  return { action, codexPath, json, relaunch, logFile };
}

/**
 * `--log-file <path>`：把 stdout / stderr 同时落一份到文件。
 *
 * 为什么需要它：Store 版汉化要写系统保护目录，必须**以管理员身份**运行本工具；
 * 而提权是通过 `ShellExecuteW('runas')` 发起的，**提权进程的输出不继承调用方的
 * 管道** —— 父进程读不到一行 stdout。日志文件因此是拿回结果的唯一通道
 * （客户端据此判断成功/失败）。普通权限运行时这个参数可以不给。
 *
 * ⚠️ 必须**同步**写：结尾那行 `[codex-zh-cn-exit] <code>` 是在 `exit` 事件里发的，
 * 异步流那时已经来不及 flush（客户端会误判成「工具没跑完」）。
 */
function teeOutputToFile(logFile) {
  let fd = null;
  try {
    fd = fs.openSync(logFile, "w");
  } catch {
    // 打不开日志文件就退化成只写控制台。
    return;
  }
  const writeSync = (chunk, encoding) => {
    try {
      fs.writeSync(
        fd,
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              String(chunk),
              typeof encoding === "string" ? encoding : "utf8",
            ),
      );
    } catch {
      // 日志写不进去绝不能影响汉化本身。
    }
  };
  const tee = (target, original) => (chunk, encoding, callback) => {
    writeSync(chunk, encoding);
    return original.call(target, chunk, encoding, callback);
  };
  process.stdout.write = tee(process.stdout, process.stdout.write);
  process.stderr.write = tee(process.stderr, process.stderr.write);
  process.on("exit", (code) => {
    const final = code === null ? process.exitCode || 0 : code;
    writeSync(`[codex-zh-cn-exit] ${final}\n`);
    try {
      fs.closeSync(fd);
    } catch {
      // 关不掉也无所谓，进程马上就没了。
    }
  });
}

const options = parseArgs(process.argv);
if (options.logFile) teeOutputToFile(options.logFile);
try {
  if (options.action === "status") status(options);
  else if (options.action === "uninstall") uninstall(options);
  else if (options.action === "install") install(options);
  else if (options.action === "save-path") {
    if (!options.codexPath) throw new Error("save-path 需要 --codex-path");
    writeSavedCodexPath(options.codexPath);
    const resolved = resolveCodexInstallDir(options.codexPath);
    console.log(`[ok] 已保存 Codex 路径: ${resolved.app}`);
  } else if (options.action === "clear-path") {
    clearSavedCodexPath();
    console.log("[ok] 已清除保存的 Codex 路径");
  } else throw new Error(`未知操作: ${options.action}`);
} catch (error) {
  if (["install", "uninstall"].includes(options.action)) {
    let toolVersion;
    try { toolVersion = loadJson("release.json").release; } catch {}
    console.error(`[codex-zh-cn-diagnostic] ${JSON.stringify(buildLocalizationDiagnostic(localizationDiagnostic, error, toolVersion))}`);
  }
  console.error(`[error] ${error.message}`);
  process.exit(1);
}
