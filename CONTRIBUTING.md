# 参与贡献

感谢你愿意帮忙。这个项目最需要三种贡献：

1. **新版 Codex 的适配**：上游一更新，菜单结构就可能变
2. **翻译遗漏**：某个菜单还是英文
3. **安装兼容性**：在你的 Windows 版本 / 安装方式上跑不通

## 开发环境

不需要特殊工具，只需要 Node.js 20+：

```bash
npm ci
npm test
```

提交前请确保 `npm test` 全绿（目前 93 项）。

## 目录速览

| 路径 | 作用 |
| --- | --- |
| `install-windows.bat` | 唯一入口，打开 PowerShell 交互菜单 |
| `scripts/install_windows.ps1` | 交互式安装器 |
| `scripts/patch-codex-zh-cn.mjs` | 补丁核心逻辑 |
| `scripts/localization-runtime.mjs` | 运行时引导的注入与路径约定 |
| `scripts/localization-patches.mjs` | 纯函数补丁规则（有单测覆盖） |
| `runtime/main.cjs` | 加载进 Codex 主进程的运行时 |
| `runtime/preload-localization.cjs` | 逐节点翻译 DOM |
| `resources/*.json` | 汉化词条 |
| `tests/` | 单元测试 |

## 改词条的注意事项

- 只加**确定的**翻译，不要机翻一堆凑数词条
- 改完跑 `npm test`：`manifest-firewall`、`resource-preflight` 等测试会校验资源完整性
- 如果新词条需要改注入逻辑（而不是纯数据），请同时补一个单测

## 判断「哪里漏了」

运行诊断：

```powershell
.\runtime\node.exe .\scripts\patch-codex-zh-cn.mjs status
```

- `asarLocalized=false` → 主进程资源没打上补丁
- `asarLocalized=true` 但 `runtimeLocalized=false` → 运行时引导没注入成功
- `runtimeVerified=false` 且 `runtimeTranslatedCount=0` → 运行时加载了但没翻译到东西

## 关于上游

本项目 fork 自 [xqnode/codex-zh-CN](https://github.com/xqnode/codex-zh-CN)（MIT）。如果你修的问题
上游同样存在，欢迎也向上游提 PR。

## 提交信息

推荐 Conventional Commits：`fix(menu): 设置菜单漏译`、`feat(runtime): 支持 26.9xx 结构`。
