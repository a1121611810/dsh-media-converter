#!/bin/bash
# One command per release, so no step can be forgotten: check the tree, run
# every suite, bump, tag, push. The tag is what makes CI publish; there is no
# local publish path.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "用法: npm run release -- <version>   例: npm run release -- 1.2.0" >&2
  exit 1
fi

[ "$(git branch --show-current)" = main ] || { echo "只在 main 上发版（当前 $(git branch --show-current)）" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作区不干净，先提交或丢弃改动" >&2; exit 1; }

# Builds both halves (dist/ and client.js), then runs every suite, including the
# artifact contract.
npm test
# The tree must already contain what the build produces; otherwise the tag
# would point at a commit whose bundle differs from the published one.
git diff --exit-code -- client.js client.js.map \
  || { echo "产物过期：提交重新构建的 client.js / client.js.map 后再发版" >&2; exit 1; }

npm version "$1" -m "chore: release v%s"
git push --follow-tags

echo "已推送 tag v$1，CI 会跑测试并发布到 npm"
