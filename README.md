# Codex Desktop 中文汉化

> **Windows 上的 Codex 界面是英文的，这个工具能把它变成中文。**
> 下载 → 解压 → 双击 → 完成。装错了能一键恢复英文。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4.svg)](#系统要求)

**Gitee**：https://gitee.com/Flower_ly/codex-setup-zh　·　**GitHub**：https://github.com/Nooonnneee/codex-setup-zh

---

## 这个工具能干什么

- ✅ 把 Codex 的**菜单、按钮、提示**都变成中文
- ✅ **没装 Codex 也能用**：它能帮你把 Codex 一起装上（国内应用商店经常下不动）
- ✅ **随时能改回来**：想恢复英文，菜单里选一下就行，不改坏你的系统
- ✅ 不用装别的软件，也不用注册账号

## 怎么用

### 第 1 步：下载

打开 **Releases** 页，下载 `codex-zh-CN-v1.0.0.zip`：

- Gitee：https://gitee.com/Flower_ly/codex-setup-zh/releases
- GitHub：https://github.com/Nooonnneee/codex-setup-zh/releases

### 第 2 步：解压

把压缩包**完整解压**到一个文件夹（比如 `D:\codex-zh-CN\`）。

> ⚠️ 别直接在压缩包里双击运行，会出错。要先解压出来。

### 第 3 步：双击运行

双击文件夹里的 **`install-windows.bat`**，会弹出一个黑色窗口：

1. 如果弹出权限提示，点「**是**」
2. 按屏幕上的提示操作：
   - **还没装 Codex** → 输入 `6` 回车，等它下载安装（约 950 MB，会比较久）
   - **已经装了 Codex** → 输入 `1` 回车
3. 完成后 Codex 会自动打开，界面已经是中文了

> 如果界面还是英文：打开 Codex 的 **Settings → General → Language**，选 **中文（中国）**。

## 界面上的那些选项

| 输入 | 作用 |
| --- | --- |
| **1** | 安装汉化（已经装了 Codex 就选这个） |
| **2** | 恢复英文 / 重置 |
| **3** | 检查汉化是否成功 |
| **4** | 重新检测一次环境 |
| **5** | Codex 装在奇怪的位置时，手动指定路径 |
| **6** | 还没装 Codex 时，用它自动安装 |
| **Q** | 退出 |

## 常见问题

**提示「未找到 Codex Desktop 安装目录」？**
说明这台电脑还没装 Codex。在菜单里输入 `6` 回车，它会帮你装。

**下载很慢或卡住了？**
文件比较大（约 950 MB），耐心等一下。如果一直不动，关掉重开一次。

**Codex 更新后界面又变回英文了？**
正常。Codex 更新会覆盖掉中文文件，重新双击 `install-windows.bat`，输入 `1` 再装一次就行。

**怎么卸载？**
在菜单里输入 `2` 恢复英文，然后删掉解压出来的文件夹。

**Windows 11 / 10 都能用吗？**
能。X64 和 ARM64 的电脑都支持。

## 系统要求

- Windows 10 或 Windows 11
- 不需要预先安装任何东西（压缩包自带运行环境）

---

<details>
<summary><b>给开发者</b></summary>

```powershell
# 检测 / 安装 / 重置
.\runtime\node.exe .\scripts\install-codex.mjs --check
.\runtime\node.exe .\scripts\install-codex.mjs
.\runtime\node.exe .\scripts\install-codex.mjs --msix "D:\OpenAI.Codex.msix"

powershell -File scripts\install_windows.ps1 -Action status
powershell -File scripts\install_windows.ps1 -Action install -CodexPath "D:\path\to\Codex"
powershell -File scripts\install_windows.ps1 -Action uninstall -CodexPath "D:\path\to\Codex"
```

```bash
npm install && npm test        # 100+ 项单元测试
```

### 与上游的差异

本仓库 fork 自 [xqnode/codex-zh-CN](https://github.com/xqnode/codex-zh-CN)（MIT）。主要改动：

- **语言包加载链解耦**：引导内联本工具的 `runtime/` 目录，不再依赖外部客户端私有目录，
  也不再按版本号挑子目录。修掉了「提示安装成功但界面没汉化」的静默失败。
- **状态与验收独立**：运行时状态改写到 `~/.codex/zh-cn-runtime-status.json`。
- **去掉版本号硬编码判据**：语言包升级后不再误判为「未验证」。
- **安装前校验运行时完整性**：缺文件时在任何写盘之前失败。
- **路径兜底**：新增 `~/.codex/zh-cn-runtime-path.txt`，工具目录被挪动后仍能找到语言包。
- **内部信号更名**：`[fmkj-*]` → `[codex-zh-cn-*]`。

副本包名保持 `OpenAI.Codex.FMKJ` —— 它是 MSIX 包身份的一部分，改动会导致重复注册。

### 安装包来源

不托管安装包。下载的是经开源镜像
[Wangnov/codex-app-mirror](https://github.com/Wangnov/codex-app-mirror)（MIT）中转的官方 MSIX，
不重打包、不改包内容，签名仍由 Microsoft 校验。换源只需改 `MIRROR_ORIGIN` 常量。

</details>

---

## 相关项目

本工具解决的是「**界面看不懂**」。
如果你要管的是「**账号太多、工具太散**」——把 Codex / Claude Code / WorkBuddy 的账号切换、
登录、配置收进一个桌面端，可以看看：

**👉 [繁梦 Ai Copilot · 下载 Windows 版](https://app.fmkj.top/download?utm_source=gitee&utm_medium=readme&utm_campaign=codex-zh-cn)**

_只想把界面变中文的话，这个仓库就够了，不需要跳到别处。_

## 致谢

- [xqnode/codex-zh-CN](https://github.com/xqnode/codex-zh-CN)（MIT）— 汉化补丁源头
- [Wangnov/codex-app-mirror](https://github.com/Wangnov/codex-app-mirror)（MIT）— 官方安装包镜像

## 免责声明

非官方中文补丁，只修改本机 Codex Desktop 的本地资源文件，与 OpenAI 无关。
安装包经第三方开源镜像获取，签名仍由 Microsoft 校验。请自行评估使用风险。

## License

[MIT](LICENSE) — 上游版权归 [xqnode](https://github.com/xqnode/codex-zh-CN) 所有。
