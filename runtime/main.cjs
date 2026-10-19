"use strict";
const { app, ipcMain, Menu, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const runtimeRoot = __dirname;
const preloadPath = path.join(runtimeRoot, "preload-localization.cjs");
const labels = Object.freeze({
  File: "文件",
  Edit: "编辑",
  Selection: "选择",
  View: "查看",
  Go: "转到",
  Run: "运行",
  Window: "窗口",
  Help: "帮助",
  "New Chat": "新对话",
  "New Task": "新建任务",
  "New Window": "新建窗口",
  "Quick Chat": "快速对话",
  Settings: "设置",
  "Open Settings": "打开设置",
  "Log Out": "退出登录",
  Close: "关闭",
  Quit: "退出",
  Undo: "撤销",
  Redo: "重做",
  Cut: "剪切",
  Copy: "复制",
  Paste: "粘贴",
  "Select All": "全选",
  Search: "搜索",
  Chats: "对话",
  Chat: "对话",
  Projects: "项目",
  Project: "项目",
  Plugins: "插件",
  Automations: "自动化",
  Automation: "自动化",
  "No chats": "暂无聊天",
  "What should we work on?": "我们该做什么？",
  "Ask anything": "随心输入",
  Custom: "自定义",
  Model: "模型",
  Models: "模型",
  Reasoning: "推理",
  Account: "账户",
  Personal: "个人",
  General: "常规",
  Appearance: "外观",
  Configuration: "配置",
  Advanced: "高级",
  About: "关于",
  Update: "更新",
  Updates: "更新",
  Language: "语言",
  Privacy: "隐私",
  "Data controls": "数据控制",
  Connections: "连接",
  Environments: "环境",
  Worktrees: "工作树",
  Archived: "已归档",
  "Keyboard shortcuts": "键盘快捷键",
  "Usage and billing": "使用情况和计费",
  Browser: "浏览器",
  "Computer use": "电脑操控",
  "MCP servers": "MCP 服务器",
  Hooks: "钩子",
  Composer: "输入框",
  "Default model": "默认模型",
  "New chat": "新对话",
  "Back to app": "返回应用",
  "Open source licenses": "开源许可证",
  "Check for Updates...": "检查更新...",
  "Check for Updates…": "检查更新…",
  "Toggle Sidebar": "切换侧边栏",
  "Open Terminal": "打开终端",
  "Task Manager": "任务管理器",
  Minimize: "最小化",
  "Zoom In": "放大",
  "Zoom Out": "缩小",
  "Actual Size": "实际大小",
});
function translateMenuItem(item) {
  if (!item) return item;
  const next = { ...item };
  if (typeof item.label === "string")
    next.label = labels[item.label.replace(/&/g, "").trim()] || item.label;
  if (Array.isArray(item.submenu))
    next.submenu = item.submenu.map(translateMenuItem);
  return next;
}
function installMenuHook() {
  try {
    const original = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (tpl) => original(tpl.map(translateMenuItem));
    const set = Menu.setApplicationMenu.bind(Menu);
    Menu.setApplicationMenu = (menu) => {
      if (menu) {
        for (const item of menu.items || []) {
          const t = labels[(item.label || "").replace(/&/g, "").trim()];
          if (t) item.label = t;
          for (const c of item.submenu?.items || []) {
            const ct = labels[(c.label || "").replace(/&/g, "").trim()];
            if (ct) c.label = ct;
          }
        }
      }
      return set(menu);
    };
  } catch (_) {}
}
function register(s) {
  try {
    if (typeof s.registerPreloadScript === "function") {
      s.registerPreloadScript({
        type: "frame",
        filePath: preloadPath,
        id: "codex-zh-cn",
      });
    } else {
      const current = s.getPreloads?.() || [];
      if (!current.includes(preloadPath))
        s.setPreloads([...current, preloadPath]);
    }
  } catch (_) {}
}
// 开源版：状态文件写在 `~/.codex/` 下，安装器从这里验收，不再跨客户端目录传话。
const os = require("node:os");
const codexHome = path.join(os.homedir(), ".codex");
const statusPath = path.join(codexHome, "zh-cn-runtime-status.json");
// 版本号取自运行时自带的 VERSION.txt（语言包升级时一起变），不再写死常量 ——
// 写死后安装器那条 `toolVersion === "0.1.4-fmkj7"` 的判据会永远为假。
let runtimeVersion = "unknown";
try {
  const line = fs
    .readFileSync(path.join(runtimeRoot, "VERSION.txt"), "utf8")
    .split(/\r?\n/)[0];
  const match = /v?([0-9][0-9.\w-]*)/.exec(line || "");
  if (match) runtimeVersion = match[1];
} catch (_) {}
let translatedHighWaterMark = 0;
let chineseVisibleHighWaterMark = 0;
function writeRuntimeStatus(translated, chineseVisible = 0) {
  translatedHighWaterMark = Math.max(
    translatedHighWaterMark,
    Number(translated) || 0,
  );
  chineseVisibleHighWaterMark = Math.max(
    chineseVisibleHighWaterMark,
    Number(chineseVisible) || 0,
  );
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    const temp = `${statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify({
        schema: 1,
        toolVersion: runtimeVersion,
        runtimeLoaded: true,
        preloadInjected: true,
        translated: translatedHighWaterMark,
        chineseVisible: chineseVisibleHighWaterMark,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    fs.renameSync(temp, statusPath);
  } catch (_) {}
}
installMenuHook();
ipcMain.on("codex-zh-cn:report", (_event, payload) =>
  writeRuntimeStatus(payload?.translated, payload?.chineseVisible),
);
writeRuntimeStatus(0);
app.whenReady().then(() => {
  register(session.defaultSession);
  try {
    Menu.setApplicationMenu(Menu.getApplicationMenu());
  } catch (_) {}
});
app.on("session-created", register);
