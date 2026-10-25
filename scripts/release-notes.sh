#!/usr/bin/env bash
# 用 .github/release-template.md 渲染发布说明，输出到 stdout。
#
# 用法：
#   ./scripts/release-notes.sh <version> [prev-version]
#
# 环境变量（均可选）：
#   PREV_VERSION  上一版本号，默认「上一版」
#   CHANGES       改动清单（Markdown 列表，可用 $'a\nb'），默认占位提示
#   IMAGE_SIZE    镜像体积，默认留待回填
#   BUILD_ID      前端内容指纹，默认按当前 public/ 现算（补发旧版本说明时需显式指定）
#   TEST_COUNT    测试通过数，默认用 mocha --dry-run 统计（补发旧版本说明时需显式指定）
#   GHCR_REPO     GHCR 仓库路径，默认 junncey/voice-channels
#
# 示例：
#   CHANGES=$'- 聊天历史分页加载\n- 修复…' PREV_VERSION=1.0.0 \
#     ./scripts/release-notes.sh 1.0.1 > body.md
#
# 只读：不修改仓库、不访问需要凭据的接口（digest 走 GHCR 匿名拉取）。
set -euo pipefail

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

case "${1:-}" in
    -h | --help) usage 0 ;;
    '') usage 1 >&2 ;;
esac

VERSION="${1#v}"
PREV_VERSION="${PREV_VERSION:-上一版}"
CHANGES="${CHANGES:-- （填写本版本改动）}"
IMAGE_SIZE="${IMAGE_SIZE:-待回填}"
GHCR_REPO="${GHCR_REPO:-junncey/voice-channels}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${REPO_ROOT}/.github/release-template.md"
[ -f "$TEMPLATE" ] || { echo "错误：找不到模板 $TEMPLATE" >&2; exit 1; }

DATE="$(date +%F)"

# --- 前端内容指纹 -------------------------------------------------------
BUILD_ID="${BUILD_ID:-}"
if [ -z "$BUILD_ID" ] && command -v node >/dev/null 2>&1; then
    # 用相对路径 + cd：Windows 上 Node 不认 Git Bash 的 /d/... 路径
    BUILD_ID="$(cd "$REPO_ROOT" && node -e "process.stdout.write(require('./app/src/version').computeBuildId('./public'))" 2>/dev/null || true)"
    if [ -n "$BUILD_ID" ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        # 指纹按工作区内容计算；有未提交改动时它不代表任何已发布版本
        echo "警告：工作区有未提交改动，BUILD_ID=${BUILD_ID} 与已发布版本不一致，请以发布后的 /api/version 为准（或显式传 BUILD_ID）。" >&2
    fi
fi
[ -n "$BUILD_ID" ] || BUILD_ID="待回填"

# --- 测试数量 -----------------------------------------------------------
# mocha --dry-run 只加载用例不执行，2~3 秒拿到准确条数；失败则退回源码计数
TEST_COUNT="${TEST_COUNT:-}"
if [ -z "$TEST_COUNT" ] && [ -x "$REPO_ROOT/node_modules/.bin/mocha" ]; then
    TEST_COUNT="$(cd "$REPO_ROOT" && ./node_modules/.bin/mocha tests/ --exit --dry-run --reporter dot 2>/dev/null |
        tr -d '\r' | sed -n 's/^[[:space:]]*\([0-9][0-9]*\) passing.*/\1/p' | head -1 || true)"
fi
if [ -z "$TEST_COUNT" ]; then
    TEST_COUNT="$(grep -ho 'it(' "$REPO_ROOT"/tests/*.js 2>/dev/null | wc -l | tr -d '[:space:]')"
fi
[ -n "$TEST_COUNT" ] && [ "$TEST_COUNT" != "0" ] || TEST_COUNT="待回填"

# --- 镜像 digest（GHCR 匿名 HEAD） -------------------------------------
DIGEST=""
token="$(curl -fsS --max-time 15 \
    "https://ghcr.io/token?scope=repository:${GHCR_REPO}:pull&service=ghcr.io" 2>/dev/null |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
if [ -n "$token" ]; then
    # 版本未推送时 HEAD 返回 404，pipefail 下必须兜底，否则脚本直接退出
    DIGEST="$(curl -fsS --max-time 20 -I \
        -H "Authorization: Bearer ${token}" \
        -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
        "https://ghcr.io/v2/${GHCR_REPO}/manifests/${VERSION}" 2>/dev/null |
        tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -1 || true)"
fi
if [ -z "$DIGEST" ]; then
    DIGEST="待回填（镜像推送后重跑本脚本）"
    echo "提示：GHCR 上暂无 ${GHCR_REPO}:${VERSION}，digest 留待回填。" >&2
fi

# --- 渲染 ---------------------------------------------------------------
# 跳过模板顶部的 HTML 注释（使用说明），避免其中的示例字段被一并替换
body="$(awk 'NR == 1 && $0 == "<!--" { skip = 1; next }
            skip { if ($0 == "-->") skip = 0; next }
            { print }' "$TEMPLATE")"
# 去掉模板注释下方的空行，避免正文以空行开头
body="$(printf '%s\n' "$body" | sed '/./,$!d')"
# 🔴 Bash 的 ${var//pat/repl} 与 sed 同源：repl 里的 & 会展开成「匹配到的模式」，
# \ 会当转义符。CHANGES 里出现 & 时占位符会被静默换回 {{CHANGES}} 本身（1.4.1 踩过），
# 所以替换前先转义反斜杠与与号；注意 replacement 必须不加引号，引号会让 \& 变成字面量。
escape_repl() {
    local s="${1//\\/\\\\}"
    printf '%s' "${s//&/\\&}"
}
set_ph() {
    local v
    v="$(escape_repl "$2")"
    body="${body//"{{$1}}"/$v}"
}
set_ph VERSION "$VERSION"
set_ph PREV_VERSION "$PREV_VERSION"
set_ph DATE "$DATE"
set_ph DIGEST "$DIGEST"
set_ph BUILD_ID "$BUILD_ID"
set_ph TEST_COUNT "$TEST_COUNT"
set_ph IMAGE_SIZE "$IMAGE_SIZE"
set_ph CHANGES "$CHANGES"

for ph in VERSION PREV_VERSION DATE DIGEST BUILD_ID TEST_COUNT IMAGE_SIZE CHANGES; do
    case "$body" in
        *"{{$ph}}"*) echo "警告：占位符 {{$ph}} 未填充" >&2 ;;
    esac
done

printf '%s\n' "$body"
