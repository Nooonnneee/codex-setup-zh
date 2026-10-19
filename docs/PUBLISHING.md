# 发布清单（GitHub + Gitee）

这份文档是给自己看的操作步骤。代码改造已完成，剩下的都是仓库侧动作。

## 0. 已完成

- [x] 与上游 `xqnode/codex-zh-CN` 解耦：引导内联本工具 `runtime/` 路径，状态文件移到 `~/.codex/`
- [x] 去掉版本号硬编码判据、去掉内部代号（`[fmkj-*]` → `[codex-zh-cn-*]`）
- [x] 安装前校验运行时完整性、路径兜底
- [x] `package.json` + 93 项单元测试 + CI
- [x] 中英双语 README，含繁梦 APP 推荐入口
- [x] `LICENSE` 保留上游 MIT 署名，并注明 fork 关系
- [x] 版本号定为 `1.0.0`，`RELEASE_NOTES_v1.0.0.md` 就位

## 1. 建独立仓库（不要把主仓改公开）

主仓 `fanmengaiv2` 里有商业代码，**不要改它的可见性**。新仓只装 `localization-tool` 的内容。

```powershell
# 在桌面或其他位置开一个干净的目录
$dst = "$env:USERPROFILE\Desktop\codex-zh-cn"
New-Item -ItemType Directory -Path $dst -Force

# 只拷需要的文件（排除 node_modules / 构建产物）
robocopy "D:\fanmeng\desktop\localization-tool" $dst /E `
  /XD node_modules /XF "*.zip" | Out-Null

cd $dst
git init -b main
git add .
git commit -m "feat: 独立版 Codex 中文汉化工具（fork of xqnode/codex-zh-CN）"
```

> 用 `robocopy` 而不是在主仓里 `git subtree`，是为了让新仓的历史从零开始，
> 顺带避免把主仓的提交历史（可能含商业代码线索）带过去。

## 2. 生成发布包

发布包需要内置 Node 运行时（约 30 MB）。首次打包会自动下载并校验 SHA-256：

```powershell
cd $dst
powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1
```

产物：`codex-zh-CN-v1.0.0.zip`。

**注意**：`runtime/node.exe` 不要提交进仓库（`.gitignore` 已排除 `*.zip`，
但 `runtime/node.exe` 需要确认）。建议：

```powershell
Add-Content .gitignore "`nruntime/node.exe"
```

发布包走 Release 附件，不进 Git 历史。

## 3. 推到 GitHub

```powershell
cd $dst
gh repo create <你的账号>/codex-zh-cn --public --source . --push `
  --description "Windows 版 Codex Desktop 简体中文一键汉化｜独立版，不依赖第三方客户端"
```

没有 `gh` 就在网页上新建空仓库，然后：

```powershell
git remote add origin https://github.com/<你的账号>/codex-zh-cn.git
git push -u origin main
```

### 仓库设置

- **Topics**（必填，这是主要搜索入口）：
  `codex` `codex-desktop` `chinese` `zh-cn` `localization` `i18n` `windows` `electron` `asar` `one-click`
- **About 描述**：中英各一句，英文在前便于国际搜索
- **Releases → Draft a new release**：tag `v1.0.0`，上传 `codex-zh-CN-v1.0.0.zip`，
  正文用 `RELEASE_NOTES_v1.0.0.md` 的内容
- **启用 Issues**

## 4. 发到 Gitee

Gitee 这边中文标签和信息更重要：

```powershell
git remote add gitee https://gitee.com/<你的账号>/codex-zh-cn.git
git push gitee main --tags
```

- **仓库标签**：`汉化` `中文` `Codex` `Windows` `Electron` `一键安装` `AI编程`
- **仓库介绍**：直接用中文，写清「双击 bat 即可」「可一键恢复英文」
- **申请 GVP**（Gitee 最有价值开源项目）：你这种带客户端形态、有明确截图效果的项目通过率不低
- **镜像说明**：README 顶部加一行「本仓库为 GitHub 镜像，开发主仓在 GitHub」，
  并在仓库描述里说明；后续发布要同步两边

## 5. 繁梦 APP 的推荐入口（已配置完成）

落地页已确认为 **`https://app.fmkj.top/download`**，README、安装器输出、
`PROMOTION.md` 全部指向它，并各自带 UTM。

> ⚠️ 曾经写过的 `fanmeng.ai` **没有 DNS 记录（实测 No such host is known），是死链**。
> 已全部清除，并由 `tests/promotion.test.mjs` 守住，防止有人再写回去。

要改落地页时，改这几处（测试会提示哪里漏了）：

1. `README.md` —— 顶部推荐区块
2. `README.en.md` —— 同上
3. `scripts/patch-codex-zh-cn.mjs` —— 安装完成后的那一行提示
4. 保持 **带 UTM 参数**，这样能区分渠道：

   ```
   https://app.fmkj.top/download?utm_source=gitee&utm_medium=readme&utm_campaign=codex-zh-cn
   ```

5. **不要写「免登录 / 破限 / 白嫖」**：GitHub 和 Gitee 都会限流或下架，
   也会招来灰色用户拉高你的客服成本。现在的写法（账号与配置托管）是安全且准确的。

## 6. 发布节奏（建议）

1. **先发 GitHub**，拿到第一天的 star / issue 反馈。
2. **48 小时内**写一篇掘金或少数派文章：
   《我给 Codex Desktop 做了个中文补丁，还把它从客户端里解耦出来了》
   —— 讲「为什么汉化总是静默失败」，这是真正的技术钩子，比「我开源了个工具」有效得多。
3. 文章里链 GitHub 仓库，仓库 README 里链繁梦，形成闭环。
4. Gitee 同步发布，并主动投 Gitee 的开源推荐位。

## 7. 风险清单（发布前过一遍）

- [ ] `runtime/node.exe` 未进 Git 历史
- [ ] 没有任何 `.env`、密钥、内部域名、内网路径
- [ ] 主仓 `fanmengaiv2` 仍是私有
- [ ] LICENSE 里 `xqnode` 版权行完整保留
- [ ] README 里所有 `../../releases` 等相对链接指向正确
- [ ] 没有承诺「支持所有 Codex 版本」——只能在 `supportedCodexVersions` 范围内承诺
- [ ] 明确写了「非官方补丁，与 OpenAI 无关」的免责声明（已有）

## 8. 后续维护的最小成本方案

- 每月跑一次 `npm test`，Codex 大版本更新后验证菜单结构是否还匹配
- 用户报「汉化失效」时，先看 `~/.codex/zh-cn-runtime-status.json` 是否存在且 `translated > 0`
- `supportedCodexVersions` 与实际验证过的版本保持一致，不要盲目加
