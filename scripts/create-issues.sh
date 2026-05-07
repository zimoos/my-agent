#!/usr/bin/env bash
# 批量创建 GitHub Issues
#
# 用法：
#   1. 确保已安装 gh CLI 并已登录：gh auth login
#   2. 或直接设置 GITHUB_TOKEN：export GITHUB_TOKEN=ghp_xxx
#   3. 运行：bash scripts/create-issues.sh

set -euo pipefail

REPO="zhuqingyv/my-agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISSUES_FILE="$SCRIPT_DIR/issues.json"

if ! command -v gh &>/dev/null; then
  echo "❌ 未找到 gh CLI。请安装：brew install gh"
  echo "   然后运行：gh auth login"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "❌ gh CLI 未登录。请运行：gh auth login"
  exit 1
fi

COUNT=$(jq length "$ISSUES_FILE")
echo "📋 将创建 $COUNT 个 issues 到 $REPO"
echo ""

for i in $(seq 0 $((COUNT - 1))); do
  TITLE=$(jq -r ".[$i].title" "$ISSUES_FILE")
  BODY=$(jq -r ".[$i].body" "$ISSUES_FILE")
  LABELS=$(jq -r ".[$i].labels | join(\", \")" "$ISSUES_FILE")

  echo "  → 创建: $TITLE"
  gh issue create \
    --repo "$REPO" \
    --title "$TITLE" \
    --body "$BODY" \
    --label "$LABELS" \
    || echo "     ⚠️ 创建失败（可能 issue 已存在或无权限）"
done

echo ""
echo "✅ 完成！"
echo "   查看 issues: https://github.com/$REPO/issues"
