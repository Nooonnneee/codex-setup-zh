#!/bin/bash
# Codex Desktop 安装器（macOS）
#
# 双击本文件即可运行。如果提示「无法打开，因为来自身份不明的开发者」：
#   → 右键点本文件 → 打开 → 再点「打开」
#   → 或终端里执行一次：chmod +x install-macos.command

set -u
cd "$(dirname "$0")" || exit 1

echo ""
echo "========================================"
echo "   Codex Desktop 安装器（macOS）"
echo "========================================"
echo ""

# 找可用的 node：优先包内自带的，其次系统安装的
NODE_BIN=""
if [ -x "./runtime/node" ]; then
  NODE_BIN="./runtime/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "  [X] 没有找到可用的 Node.js"
  echo ""
  echo "  这个安装包应该自带运行环境。请确认你是**完整解压**了整个"
  echo "  压缩包，而不是只拖出来一个文件。"
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

if [ "$NODE_BIN" = "./runtime/node" ]; then
  chmod +x "./runtime/node" 2>/dev/null || true
fi

if [ ! -f "./scripts/install-codex-mac.mjs" ]; then
  echo "  [X] 缺少 scripts/install-codex-mac.mjs"
  echo "  请重新完整解压发布包。"
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "  正在检查并安装 Codex…"
echo "  安装包较大（约 750 MB），下载可能需要几分钟。"
echo ""

"$NODE_BIN" "./scripts/install-codex-mac.mjs"
STATUS=$?

echo ""
if [ $STATUS -eq 0 ]; then
  echo "  ✅ 完成。请在「启动台」或「应用程序」里打开 ChatGPT。"
  echo ""
  echo "  注意：macOS 版 Codex **没有简体中文界面**，"
  echo "        本仓库的汉化只支持 Windows。"
else
  echo "  [X] 安装未完成（退出码 $STATUS）"
  echo "      请把上面的报错信息反馈到 Issues。"
fi

echo ""
read -n 1 -s -r -p "按任意键关闭…"
echo ""
