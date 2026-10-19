import path from "node:path";
import os from "node:os";

/**
 * 运行时汉化包的公共约定 —— 安装器、运行时自身、卸载流程都读这里。
 *
 * 开源版**不依赖任何客户端**：语言包就放在本工具的 `runtime/` 目录，
 * 状态文件写在 `~/.codex/`，不再读 `%LOCALAPPDATA%\FMKJ Connect\`。
 */

/** 运行时引导标记。改这个字符串会让已装用户升级时重新注入，务必保持稳定。 */
export const RUNTIME_BOOTSTRAP_MARKER = "/* codex-zh-cn-runtime-bootstrap-v2 */";

/** 旧版（FMKJ Connect 时期）的标记，仅用于**识别并替换**老注入，不要再用它写新代码。 */
export const LEGACY_RUNTIME_BOOTSTRAP_MARKER = "/* fmkj-runtime-bootstrap-v1 */";

/** 运行时状态文件名，落在 `<codexHome>/` 下。 */
export const RUNTIME_STATUS_FILE = "zh-cn-runtime-status.json";

/**
 * 安装根目录（`<工具目录>/runtime`）。运行时 `main.cjs` 与 preload 都在这里，
 * 与安装器同源，所以在 MSIX 副本或便携版里路径都不会漂。
 */
export function resolveRuntimeDir(projectRoot) {
  return path.join(projectRoot, "runtime");
}

/** 运行时状态文件路径。客户端只读它做验收，不再跨客户端目录传话。 */
export function resolveRuntimeStatusPath(codexHome) {
  return path.join(codexHome, RUNTIME_STATUS_FILE);
}

export function defaultCodexHome() {
  return path.join(os.homedir(), ".codex");
}

/**
 * 生成注入到 Codex 主进程的引导源码。
 *
 * 与旧版的区别只有一处、但很关键：路径**编译期写死为本工具的真实 `runtime/` 目录**，
 * 不再依赖 `%LOCALAPPDATA%\FMKJ Connect\Tools\` 下按版本号挑目录。后者一旦目录名
 * 和常量对不上，`require` 抛错会被 `catch` 吞掉，表现为「提示安装成功但界面没汉化」。
 *
 * 安装目录被整体搬走（例如用户把工具放进 U 盘再拷到别的电脑）时，引导会依次尝试
 * 记录在状态文件里的路径和 `~/.codex/zh-cn-runtime-path.txt` 里记的路径兜底。
 */
export function buildRuntimeBootstrap(runtimeDir) {
  const normalized = path.normalize(runtimeDir).replace(/\\/g, "\\\\");
  return (
    `${RUNTIME_BOOTSTRAP_MARKER}\n` +
    `(() => { try {\n` +
    `  const path = require("node:path");\n` +
    `  const fs = require("node:fs");\n` +
    `  const os = require("node:os");\n` +
    `  const candidates = [${JSON.stringify(path.normalize(runtimeDir))}];\n` +
    `  try {\n` +
    `    const hint = path.join(os.homedir(), ".codex", "zh-cn-runtime-path.txt");\n` +
    `    const line = fs.readFileSync(hint, "utf8").split(/\\r?\\n/)[0].trim();\n` +
    `    if (line) candidates.push(line);\n` +
    `  } catch (_) {}\n` +
    `  let lastError = null;\n` +
    `  for (const dir of candidates) {\n` +
    `    const entry = path.join(dir, "main.cjs");\n` +
    `    if (!fs.existsSync(entry)) continue;\n` +
    `    try { require(entry); return; } catch (error) { lastError = error; }\n` +
    `  }\n` +
    `  throw lastError || new Error("汉化运行时不存在: " + candidates.join(" | "));\n` +
    `} catch (error) {\n` +
    `  try { process.stderr.write("[codex-zh-cn] runtime bootstrap failed: " + String((error && error.stack) || error) + "\\n"); } catch (_) {}\n` +
    `} })();\n`
  );
}

/**
 * 匹配整块旧引导：标记行 + 紧随其后的那一行代码。
 *
 * ⚠️ 只切标记那一行会留下旧代码（实测越注入越长），必须是「标记 + 下一行」整块替换。
 */
export const RUNTIME_BOOTSTRAP_BLOCK_PATTERN = new RegExp(
  `(?:\\/\\* (?:fmkj-runtime-bootstrap-v1|codex-zh-cn-runtime-bootstrap-v2) \\*\\/)[\\r\\n]+[^\\n]*[\\r\\n]*`,
);

export function injectRuntimeBootstrapSource(source, runtimeDir) {
  // 用 JSON.stringify 做比较而不是裸路径：注入进源码的是 JSON 字面量（反斜杠成对转义），
  // 直接拿 normalize 过的裸路径去 `includes` 会永远为假，幂等判断就失效了。
  const normalized = path.normalize(runtimeDir);
  const marker = JSON.stringify(normalized);
  if (source.includes(RUNTIME_BOOTSTRAP_MARKER) && source.includes(marker)) {
    return { source, changed: false };
  }
  const bootstrap = buildRuntimeBootstrap(normalized);
  const next = source.replace(RUNTIME_BOOTSTRAP_BLOCK_PATTERN, bootstrap);
  if (next !== source) return { source: next, changed: true };
  return { source: bootstrap + source, changed: true };
}

/** 判断 asar 主进程包里是否已经注入过（新旧标记都算「注入过」，便于升级重写）。 */
export function hasRuntimeBootstrap(source) {
  return (
    source.includes(RUNTIME_BOOTSTRAP_MARKER) ||
    source.includes(LEGACY_RUNTIME_BOOTSTRAP_MARKER)
  );
}

/** 判断是否还是旧版（FMKJ Connect）引导 —— 用来决定是否需要重写注入。 */
export function needsRuntimeBootstrapUpgrade(source) {
  return (
    source.includes(LEGACY_RUNTIME_BOOTSTRAP_MARKER) &&
    !source.includes(RUNTIME_BOOTSTRAP_MARKER)
  );
}
