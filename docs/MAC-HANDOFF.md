# macOS 支持 · 交接说明

> 这份是给下一个会话的 agent 看的。读完就能接着干，不需要回溯之前的对话。

## 背景

仓库 `codex-zh-cn` 是 **Windows 版 Codex Desktop 的简体中文汉化工具**，已发布 v1.0.0：
- Gitee：https://gitee.com/Flower_ly/codex-zh-cn
- GitHub：https://github.com/Nooonnneee/codex-zh-cn

现在要新增一件事：**让本工具也能在 macOS 上一键安装 Codex**。

## 关键前提（必须先知道）

1. **macOS 版做不了汉化。** Windows 版是 Electron，改 `app.asar` 即可；macOS 版是原生 Swift 应用，
   没有对应资源可改。所以 mac 这条线**只做「装 Codex」，不做汉化**。用户已确认这个范围。
2. **安装包不是我们自己托管。** 来自开源镜像 `Wangnov/codex-app-mirror`（MIT），
   和 Windows 那条线是同一个镜像项目。必须注明来源（仓库已有类似测试守着）。
3. **`.bat` 在 mac 上跑不了。** Mac 需要 `.command` 文件，双击才可执行。

## 镜像提供的 macOS 下载地址

已实测可用（302 跳到 CDN）：

| 架构 | 短链 |
| --- | --- |
| Apple Silicon | `https://codexapp.agentsmirror.com/latest/mac-arm64` |
| Intel | `https://codexapp.agentsmirror.com/latest/mac-intel` |
| 校验和 | `https://codexapp.agentsmirror.com/latest/checksums` |

## manifest 结构（`https://codexapp.agentsmirror.com/latest/manifest`）

```
{
  "codexVersion": "26.1013.40934",
  "sources": {
    "macos": {
      "arm64": {
        "sha256": "37bd7189...",          // 与 DMG 对应
        "contentLength": 787907132,       // 约 751 MB
        "minimumSystemVersion": "13.0",
        "bundleIdentifier": "com.openai.codex",
        "bundleShortVersion": "26.1013.40934",
        "downloadable": true,
        "status": "downloadable"
      },
      "x64": { ... }                      // 约 739 MB
    },
    "windows": { ... }
  }
}
```

实测数据（2026-10-19）：arm64 751 MB / x64 739 MB，最低 macOS 13.0。

## 已完成

**`scripts/install-codex-mac.mjs`** —— 已写好并通过语法检查：

- `--check` / `--no-install` / `--dmg <路径>` / `--arch` / `--keep`
- 架构自动判断（`os.arch()` → arm64 / x64）
- 从 manifest 读 sha256、minSystemVersion
- 下载时边下边算 SHA-256，**不匹配就删文件并报错**
- `hdiutil attach -nobrowse -noverify` 挂载，拿挂载点后复制
- **`ditto` 而非 `cp`** —— 保留资源分支、扩展属性、代码签名
- 目标优先 `/Applications`，不可写则退回 `~/Applications`
- `xattr -dr com.apple.quarantine` 清隔离属性，避免「无法验证开发者」
- 安装后打印提示：**macOS 版没有中文界面**

## 剩余工作

### 1. 加 `.command` 入口（Mac 双击）

参照 `install-windows.bat` 的角色，新建 `install-macos.command`：

- 第一行必须是 `#!/bin/bash`
- `cd "$(dirname "$0")"`
- 用 `runtime/node`（若无则回退系统 `node`，再没有就提示）
- 调 `scripts/install-codex-mac.mjs`
- 结尾 `read -n 1 -p "按任意键关闭"` 防止窗口闪退
- **必须写成 LF 换行**（`.gitattributes` 里要加 `*.command text eol=lf`）
- **提交前 `chmod +x`**（git 需要记录可执行位）

### 2. 更新 README

当前 README 是精简后的用户向结构（主内容 83 行 + `<details>` 开发者区）。
mac 需要：
- 顶部「这个工具能干什么」提到 **Windows 汉化 / macOS 仅安装**
- 独立一节说明 mac 怎么用（下载 → 解压 → 双击 `.command` → 终端里输密码）
- 明确写 **mac 版没有中文界面**，避免用户下载后发现没汉化而差评

`README.en.md` 同步。

### 3. 加测试

参照 `tests/install-codex.test.mjs` 的写法，新建 `tests/install-codex-mac.test.mjs`：

- `readManifestInfo` 能正确区分 arm64 / x64，不串味
- 缺 `sources.macos` 返回 null 而不是抛错
- 脚本内无明文 `http://`
- 注明镜像仓库地址（`Wangnov/codex-app-mirror`）与 MIT
- 只走 https
- `.command` 文件存在且是 LF 换行

### 4. 推送

**Gitee**：`git push gitee main` 直接可用（之前都成功）。

**GitHub**：git 直连被重置，**必须走 REST API**。之前用的方法：
- `PUT https://api.github.com/repos/Nooonnneee/codex-zh-cn/contents/<path>`
- curl 加 `--ssl-no-revoke`（否则报 `CRYPT_E_REVOCATION_OFFLINE`）
- 路径逐段 `[Uri]::EscapeDataString`，否则中文文件名会 `Malformed input to a URL function`
- 已有文件要先 `GET` 拿 `sha` 再带上

## 环境陷阱（踩过，别重复）

1. **PowerShell 脚本必须 UTF-16 LE + BOM**。用 UTF-8 存 `.ps1` 会中文乱码导致语法错误。
2. **临时 .ps1 脚本同理**，写完要转编码再跑。
3. **API 返回的中文看起来是乱码，多半是终端解码问题**，用 `[Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())` 验证，别急着改数据。
4. **不要用 `Get-Content`/`Set-Content` 批量改中文源码**，会把编码搞坏。用 edit 工具。
5. `git rm --cached` 之后接 `git add -A` 会把文件加回来，删文件要用 `git rm`。

## 约束

- **不使用 GitHub Actions**（用户额度有限）。所有检查都是本地 `npm run verify`。
- 不要为了「保持活跃」制造空提交。
- 推广链接统一用 `https://app.fmkj.top/download`，**不要写 `fanmeng.ai`（已确认是死链）**，
  有测试守着。

## 验证命令

```bash
npm install
npm test              # 当前 112 项，加完 mac 测试应该更多
npm run check-upstream  # 检查上游版本
```
