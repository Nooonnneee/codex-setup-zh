"use strict";
(() => {
  let ipcRenderer = null;
  try {
    ({ ipcRenderer } = require("electron"));
  } catch (_) {}
  const labels = {
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
    "Back to app": "返回应用",
    "Open source licenses": "开源许可证",
    "Toggle Sidebar": "切换侧边栏",
    "Open Terminal": "打开终端",
    "Task Manager": "任务管理器",
    Minimize: "最小化",
    "Zoom In": "放大",
    "Zoom Out": "缩小",
    "Actual Size": "实际大小",
  };
  const clean = (v) =>
    String(v || "")
      .replace(/\s+/g, " ")
      .trim();
  // Do not permanently mark elements as translated. React reuses DOM nodes and can
  // restore their English text later; the observer must be able to translate the
  // same node again whenever its current value matches an English key.
  const replace = (node) => {
    if (!(node instanceof HTMLElement)) return 0;
    let n = 0;
    if (node.children.length === 0) {
      const t = clean(node.textContent);
      if (labels[t] && labels[t] !== t) {
        const text = [...node.childNodes].find(
          (x) => x.nodeType === Node.TEXT_NODE,
        );
        if (text) {
          text.nodeValue = labels[t];
          n++;
        }
      }
    }
    for (const a of ["aria-label", "title", "placeholder"]) {
      const t = clean(node.getAttribute(a));
      if (labels[t] && labels[t] !== t) {
        node.setAttribute(a, labels[t]);
        n++;
      }
    }
    return n;
  };
  const scan = (root) => {
    let n = 0;
    if (root instanceof HTMLElement) n += replace(root);
    for (const e of root.querySelectorAll?.(
      'button,a,[role="button"],[role="link"],span,label,h1,h2,h3,p,div,input,textarea',
    ) || [])
      n += replace(e);
    return n;
  };
  const report = (translated) => {
    try {
      const chineseVisible = (
        (document.body?.textContent || "").match(/[\u4e00-\u9fff]/g) || []
      ).length;
      ipcRenderer?.send("codex-zh-cn:report", {
        translated: Number(translated) || 0,
        chineseVisible,
      });
    } catch (_) {}
  };
  const start = () => {
    let translated = scan(document.documentElement);
    report(translated);
    const observer = new MutationObserver((records) => {
      let changed = 0;
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) changed += scan(node);
          else if (node.nodeType === Node.TEXT_NODE && node.parentElement)
            changed += replace(node.parentElement);
        }
        if (r.type === "characterData" && r.target.parentElement)
          changed += replace(r.target.parentElement);
        if (r.type === "attributes") changed += replace(r.target);
      }
      if (changed) {
        translated += changed;
        report(translated);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "placeholder"],
    });
    window.dispatchEvent(
      new CustomEvent("codex-zh-cn-ready", { detail: { translated } }),
    );
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
