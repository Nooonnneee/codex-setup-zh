# 1.0.0

这是独立版的首个正式版本：解压即用，不再依赖任何第三方客户端。
**从这一版开始，一个工具同时管「装 Codex」和「汉化」** —— 新机器不用先去别处找安装包。

## 新增：安装 Codex

- 菜单新增 **[6] 安装 Codex**，仅在未检测到 Codex 时出现
- 安装包为 Microsoft Store 分发的官方 MSIX（约 950 MB），经开源镜像
  [Wangnov/codex-app-mirror](https://github.com/Wangnov/codex-app-mirror)（MIT）中转，国内可直连
- 下载时带进度条并计算 SHA-256；**不重打包、不改包内容**，签名仍由 Microsoft 校验
- 用 `Add-AppxPackage` 安装后，轮询 `Get-AppxPackage` 直到包真正注册，再核对版本才报成功
- 命令行走 `scripts/install-codex.mjs`，支持 `--check` / `--no-install` / `--msix` / `--arch`

## 其他改进

- 未装 Codex 时，环境面板直接给出「选 [6] 自动安装 / 选 [5] 手动指定」的引导，
  并说明本工具只汉化已安装的 Codex、不含本体
- 检测同时覆盖 Appx 与便携版，不会把便携版误判成「未安装」而诱导用户多下一遍 950 MB
- 安装完成后打印一行相关项目提示（可用 `CODEX_ZH_NO_PROMO=1` 关闭），不弹窗、不要求注册

## 相对上游的主要改动

- **语言包加载链解耦**：引导内联本工具的 `runtime/` 目录，不再依赖外部客户端的私有目录，
  也不再按版本号挑子目录。修掉了「提示安装成功但界面没汉化」的静默失败。
- **状态与验收独立**：运行时状态改写到 `~/.codex/zh-cn-runtime-status.json`，
  卸载时一并清理，不再跨客户端目录传话。
- **去掉版本号硬编码判据**：语言包版本升级后不再误判为「未验证」。
- **安装前校验运行时完整性**：缺 `runtime/main.cjs` 或 preload 时在任何写盘之前失败。
- **路径兜底**：新增 `~/.codex/zh-cn-runtime-path.txt`，工具目录被挪动后仍能找到语言包。
- **内部信号更名**：`[fmkj-*]` → `[codex-zh-cn-*]`。
- **安装根目录中性化**：`%LOCALAPPDATA%\CodexZhCN\app`。
- **工程化**：补充 `package.json`、可一键运行的单元测试（**100+ 项**）与 Windows CI。

## 升级说明

- 从旧版（`0.1.x-fmkj*`）升级：直接解压新版覆盖旧目录，重新运行 `install-windows.bat` 选 **[1]**。
  旧注入会被整块替换，不会叠加。
- 已装用户的汉化副本位置从 `%LOCALAPPDATA%\FMKJ\CodexZhCN` 迁到 `%LOCALAPPDATA%\CodexZhCN\app`，
  重装一次即完成迁移。

## 未改动

副本包名保持 `OpenAI.Codex.FMKJ` —— 它是 MSIX 包身份的一部分，改动会导致重复注册。

---

**文件**：`codex-setup-zh-v1.0.0.zip`（约 33 MB，内含固定版本 Node 运行时）
**系统要求**：Windows 10 / 11（x64 或 arm64），无需预装 Node.js
