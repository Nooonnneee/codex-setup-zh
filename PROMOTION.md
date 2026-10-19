# 首发推广素材

这份不是给用户看的，是发布时直接复制粘贴的文案库。按平台分开写，
**不同平台不能发同一份**——每个平台的用户在意的东西不一样。

> 发布前先确认：仓库地址、下载页 UTM 参数已替换成你的实际值。

## 落地页（已确认可用）

| 用途 | 地址 |
| --- | --- |
| **下载页**（Windows 版） | https://app.fmkj.top/download |
| 网页版工作台 | https://app.fmkj.top/app |

> ⚠️ `fanmeng.ai` **没有 DNS 记录，是死链**，本仓库任何位置都不要再写它。
> 所有推广链接统一用 `app.fmkj.top`。

---

## 0. 一句话定位（所有平台都从这个出发）

**主推卖点**：一个工具同时装 Codex + 汉化，双击即用。

**副线卖点**：开了源，不依赖任何第三方客户端（这是相对同类项目的差异点）。

**关键约束**：不要讲成「免登录 / 破解 / 白嫖」，这会毁掉口碑也招来灰色用户。

---

## 1. GitHub / Gitee 仓库描述

**Gitee 仓库介绍**（一行，搜索主要入口）：

```
Windows 版 Codex Desktop 中文汉化｜一个工具同时装 Codex 和汉化，双击即用，可一键恢复英文
```

**GitHub About**（英文在前便于国际搜索）：

```
One-click Simplified Chinese localization for Codex Desktop on Windows — also installs Codex itself. Reversible.
```

**Topics / 标签**：

```
GitHub:  codex  codex-desktop  chinese  zh-cn  localization  i18n  windows  electron  asar  one-click
Gitee:   汉化  中文  Codex  Windows  Electron  一键安装  AI编程  桌面应用  开源工具  简体中文
```

---

## 2. 掘金 / 少数派技术长文

**标题候选**（选一个）：

- 我给 Codex Desktop 做了个中文补丁，顺手把它从客户端里解耦了出来
- 汉化总失败？聊聊 AI 桌面应用本地化的几个坑
- 一个 bat 搞定 Codex 安装 + 汉化：踩坑记录

**正文骨架**：

```markdown
## 起因

Windows 上的 Codex Desktop 界面是英文的。搜了一圈，有项目做了汉化，但都要先装某个客户端才能用。
我想做的是：下载、解压、双击、完事。

## 汉化桌面应用到底难在哪

Codex 是 Electron 应用，界面分三层，每层都要单独处理：

1. **主进程菜单**——硬编码在 `app.asar` 里，要解包、替换、再打包，还要同步 exe 里内嵌的
   asar 完整性哈希，否则应用起不来。
2. **i18n 词条**——官方有 zh-CN 语言包，但被一个 feature gate 关着，
   要靠精确匹配压缩后的代码特征来打开。压缩器换个版本，特征就变。
3. **动态渲染的 React 页面**——静态词条覆盖不到，要靠 Electron preload
   在运行时逐节点翻译，还不能破坏元素身份（否则 React 会重渲染、状态丢失）。

## 最坑的一个 bug：静默失败

原本的语言包加载是这样写的：

    require(path.join(LOCALAPPDATA, "某客户端", "Tools", "codex-zh-cn-0.1.7", "runtime", "main.cjs"))

目录名写死，版本一升级就找不到。而 `require` 的报错被 `catch` 吞掉了，
结果就是：**安装器提示「汉化成功」，但界面一个字都没变**，而且没有任何日志。

修复方式不是「记得改版本号」，而是让路径不可能出错：
安装时把**当前工具自己的绝对路径**编译期写进引导代码，
再留一个 `~/.codex/zh-cn-runtime-path.txt` 兜底（工具目录被挪动时用）。

## 还做了个装 Codex 的功能

后来发现很多人卡在更前面：Codex 本身还没装，或者 Store 下载卡住。
于是加了个 [6] 安装 Codex，走开源镜像 `Wangnov/codex-app-mirror`（MIT）——
它每 15 分钟探测官方更新、原样镜像官方 MSIX，签名仍由 Microsoft 校验。

安装完成后会轮询 `Get-AppxPackage` 直到包**真正注册**，而不是拿到成功返回就报完成。
（`Add-AppxPackage` 返回 0 不等于就位，这个坑也踩过。）

## 现在什么样

- 双击 `install-windows.bat`，没装 Codex 就选 [6]，装了就直接选 [1]
- 汉化可一键恢复英文
- 95 项单元测试，Windows CI

仓库：[Gitee](https://gitee.com/Flower_ly/codex-zh-cn) / [GitHub](https://github.com/lynnliuyu/codex-zh-cn)

如果你也在维护多个 AI 编程工具账号，可以看看我做的桌面端 [繁梦](https://app.fmkj.top/download?utm_source=juejin&utm_medium=article&utm_campaign=codex-zh-cn)。
```

**结尾必须带 UTM**，否则你不知道这篇文章带来多少转化。

---

## 3. V2EX（分享创造节点）

V2EX 用户讨厌自吹，讲实话就行：

```
标题：写了个 Codex Desktop 中文补丁，顺手解决了「汉化提示成功但界面没变」的问题

Windows 上 Codex 界面是英文的，之前有项目做了汉化但要先装客户端。
我把它拆出来了，顺便加了个装 Codex 的功能（走 Wangnov 的开源镜像）。

踩到的坑主要是 asar 这一层：改完 app.asar 必须同步 exe 里嵌的完整性哈希，
不然应用直接起不来。还有语言包路径写死导致静默失败——安装器说成功，
界面没变化，没有任何报错，查了很久。

现在可以一键恢复英文。95 项单测。

https://gitee.com/Flower_ly/codex-zh-cn

不是广告，就是想听听有没有更优雅的做法。
```

---

## 4. 小红书 / 即刻（面向非技术向用户）

**小红书标题**：「Codex 终于能看懂了」

```
Codex 桌面版界面全是英文，菜单看不懂真的很劝退 🥲

找了个中文补丁，下载解压双击就行，装完变中文，不满意还能一键恢复英文。

它还能顺便帮你装 Codex（国内 Store 经常下不动）。

搜索：Codex 中文补丁
```

配图建议：**汉化前/后对比**（左边英文菜单、右边中文菜单），这比任何文字都有效。

---

## 5. X / Twitter

```
Made a one-click Simplified Chinese localization for Codex Desktop on Windows.

Tricky parts:
• patching app.asar + re-syncing the integrity hash
• a bootstrap that silently failed when the path was hardcoded
• translating React-rendered nodes without breaking element identity

Also installs Codex itself. MIT.

[链接]
```

---

## 6. 繁梦客户端的推广位怎么放

**原则：不要抢主戏。** 用户在找一个汉化工具，硬推产品会反感。

**已经做的（README 顶部）**：说明「本工具解决看不懂界面，繁梦解决账号太多」，并明确写
「如果你只想把界面变中文，这个仓库就够了」。**这句话很重要**，它让推荐可信。

**还可以做的**：

1. **汉化成功后的控制台输出**（最有效的位置）
   装完那一刻，用户正处于「成功了，真好」的情绪高点：

   ```
   [ok] 汉化安装完成
   [i]  界面已是中文。想管理多个 Codex 账号、自动更新？
        → https://app.fmkj.top/download?utm_source=installer&utm_medium=cli&utm_campaign=codex-zh-cn
   ```

   这条要**克制**：一行，不提「注册」，不弹窗。

2. **README 底部**再放一次（有人直接滚到底部找链接）

3. **Issue 模板里**：「如果你遇到的是账号/配置问题，可能更适合繁梦」——
   把非汉化类问题分流出去，减少你的维护负担

---

## 7. 发布节奏

1. **先发 Gitee + 掘金长文**（国内主战场），当天
2. **48 小时内**发 V2EX 和 X
3. **一周后**发小红书（此时已有真实用户反馈可以引用）
4. **GitHub 同步镜像**，给国际流量

**别一次全发**：同一批内容分散到不同平台，能延长曝光周期；一次性发完，
第二天就没人看了。

---

## 8. 效果怎么衡量

给每个渠道单独打 UTM：

| 渠道 | utm_source | utm_medium |
| --- | --- | --- |
| Gitee README | `gitee` | `readme` |
| GitHub README | `github` | `readme` |
| 掘金文章 | `juejin` | `article` |
| V2EX | `v2ex` | `forum` |
| 小红书 | `xiaohongshu` | `social` |
| 安装器输出 | `installer` | `cli` |

**看两个数**：仓库 star/issue 数（说明工具本身有价值），以及繁梦的注册来源分布
（说明引流是否有效）。**前者比后者重要**——工具做不好，引流再多也是负口碑。
