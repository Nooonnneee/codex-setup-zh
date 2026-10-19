# Gitee 镜像说明

本仓库同时托管在两处，内容一致：

- **GitHub（主仓）**：https://github.com/lynnliuyu/codex-zh-cn
- **Gitee（国内镜像）**：https://gitee.com/Flower_ly/codex-zh-cn

## 为什么有这份文件

Gitee 上有些东西和 GitHub 不一样，写在这里免得后来者困惑：

1. **`.github/workflows/` 不会在 Gitee 上运行。** 那是 GitHub Actions 的配置，
   Gitee 会直接忽略。Gitee 用 `.workflow/` 目录下的 `*.yml`（见本目录）。
2. **安装包在各自的 Releases 页**，不随 Git 历史分发（`runtime/node.exe` 约 30 MB，
   刻意不进仓库）。
3. **Issue 模板**用的是 GitHub 的 `.github/ISSUE_TEMPLATE/` 格式，Gitee 不解析它，
   但文件本身是纯 YAML，也能当模板参考。

## 同步方式

```bash
git remote add gitee https://gitee.com/Flower_ly/codex-zh-cn.git
git push gitee main --tags
```

**不要手动改 Gitee 上的文件**，否则下次推送会冲突。所有改动都在 GitHub 侧完成后推送。

## 镜像是否滞后

如果 Gitee 上的版本落后，以 GitHub 为准。本文件所在提交即为最后一次同步点。
