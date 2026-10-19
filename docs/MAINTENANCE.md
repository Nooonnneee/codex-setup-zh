# 维护节奏

这份是给自己看的：多久做一次、每次做什么、什么算「该发版了」。

> ⚠️ 不用 GitHub Actions（额度有限）。所有检查都在本地手动跑，
> 一条命令即可，不需要开网页。

---

## 每次动手前：一条命令

```bash
npm run verify
```

它会做两件事：

1. `check-upstream` —— 对比官方最新 Codex 版本与 `resources/release.json` 里登记的适配版本
2. `test` —— 跑全部单元测试（100+ 项）

**退出码**：`0` 一切正常 / `1` 有未验证的新版本 / `2` 检查本身失败（多半是网络）。

看到 `1` 不代表汉化坏了，只代表**这个版本你没验证过**。

---

## 每月：5 分钟

| 动作 | 命令 / 位置 |
| --- | --- |
| 跑一次检查 | `npm run verify` |
| 看有没有新 Issue | GitHub / Gitee 的 Issues 页 |
| 回一句用户的提问 | 哪怕只是「收到，我看下」 |

**回 Issue 比提交代码更能体现项目活着。** 三个月没提交但 Issue 秒回的仓库，
比每天自动提交但没人管的仓库活得多。

---

## 上游出新版时：15 分钟

`npm run verify` 报 `exit=1` 时：

1. **真机验证**：装上新版 Codex，跑一次 `install-windows.bat` 选 `[1]`
2. **看菜单**：顶部菜单栏（文件/编辑/查看/窗口/帮助）是不是中文
3. **看动态页面**：随便点开一个会话，界面文字有没有变成中文
4. 都正常 → 把版本号加进 `resources/release.json`：

   ```json
   "supportedCodexVersions": [
     "26.930.3930.0",
     "26.1013.4894.0"   ← 新加这个
   ]
   ```

5. 再跑 `npm run verify`，确认 `exit=0`

**如果菜单结构变了**（主进程硬编码文案被改写，`patchMainBundle` 匹配不上），
需要在 `resources/menu-hardcoded-zh-CN.json` 里补新词条，然后跑测试确认。

---

## 每季度：30 分钟

| 动作 | 说明 |
| --- | --- |
| 全量回归 | 在干净机器上完整走一遍「装 Codex → 汉化 → 恢复英文」 |
| 依赖升级 | `npm update`，然后 `npm run verify` |
| 检查镜像 | 访问 https://codexapp.agentsmirror.com/latest/manifest 确认还活着 |
| 看仓库数据 | Gitee / GitHub 的 star、clone 数，判断要不要调整文案 |

---

## 什么时候该发新版

不必为了「看起来活跃」而发版。**只有这几种情况值得发**：

- 适配了新版本 Codex（用户实际会遇到的）
- 修了用户报的漏译或 bug
- 安装流程有实质改进

**不要做的事**：

- ❌ 为了活跃而提交空 commit
- ❌ 自动改版本号、改日期
- ❌ 发一个只有版本号变化的 Release

这类操作在技术社区里很敏感，star 反而会掉。

---

## 发版的完整流程

```bash
# 1. 改版本号（package.json + resources/release.json）
# 2. 写发布说明
#    新建 RELEASE_NOTES_v<新版本>.md
# 3. 跑检查
npm run verify

# 4. 重新打包
powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1

# 5. 提交并打 tag
git add -A
git commit -m "release: v1.0.1"
git tag v1.0.1
git push origin main --tags
```

然后在 Gitee 和 GitHub 网页上各建一个 Release，上传 zip。

> GitHub 的 Release 也可以用 API 建（不需要 Actions 额度），
> 但手动更快，且不用暴露 token。

---

## 出问题时的排查顺序

用户报「汉化了但界面还是英文」：

1. 让对方跑 `.\runtime\node.exe .\scripts\patch-codex-zh-cn.mjs status`
2. 看输出里的 `asarLocalized` / `runtimeLocalized` / `runtimeVerified`
3. 三个都 `true` 但还是英文 → 多半是 Codex 版本结构变了
4. `runtimeLocalized=false` → 语言包路径问题，看 `~/.codex/zh-cn-runtime-path.txt`
