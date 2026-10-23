#!/usr/bin/env bash
# ============================================================
# ACR 公开仓库标签审计（只读，不会删除任何东西）
#
# 用途：ACR 个人版既不支持 Registry 删除接口，也没有生命周期规则，
#       "只保留最新 N 个版本" 只能人工在控制台执行。本脚本负责列出
#       当前标签、保留哪几个、以及需要手动删除哪几个。
#
# 用法：
#   ACR_USER=xxx ACR_PASS=yyy ./scripts/acr-tags.sh
#   KEEP=2 ./scripts/acr-tags.sh              # 保留 2 个版本
#   ACR_REPO=blog ./scripts/acr-tags.sh       # 查别的仓库
#
# 环境变量：
#   ACR_USER / ACR_PASS   必填，ACR 登录凭据
#   ACR_REGISTRY          默认 crpi-a3ur4k2rueat32kn.cn-beijing.personal.cr.aliyuncs.com
#   ACR_NAMESPACE         默认 b1at-public
#   ACR_REPO              默认 voice-channels
#   KEEP                  默认 3，保留的最新版本个数
# ============================================================
set -euo pipefail

REGISTRY="${ACR_REGISTRY:-crpi-a3ur4k2rueat32kn.cn-beijing.personal.cr.aliyuncs.com}"
NAMESPACE="${ACR_NAMESPACE:-b1at-public}"
REPO="${ACR_REPO:-voice-channels}"
KEEP="${KEEP:-3}"
FULL="${NAMESPACE}/${REPO}"

: "${ACR_USER:?请设置 ACR_USER（ACR 用户名）}"
: "${ACR_PASS:?请设置 ACR_PASS（ACR 密码）}"

# 从单行 JSON 里取字段值
json_field() {
    grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed 's/.*:"//; s/"$//'
}

# 1) 拿 Bearer token
# 注意：/v2/ 未认证时必然返回 401 并带 WWW-Authenticate 头，这是正常握手，
# 所以这里不能加 -f，否则 curl 会直接以 22 退出。
challenge=$(curl -sS -D - -o /dev/null "https://${REGISTRY}/v2/" | tr -d '\r' |
    sed -n 's/.*[Ww]ww-[Aa]uthenticate: *Bearer //Ip')
realm=$(printf '%s' "$challenge" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')
service=$(printf '%s' "$challenge" | sed -n 's/.*service="\([^"]*\)".*/\1/p')
if [ -z "$realm" ]; then
    echo "错误：无法从 https://${REGISTRY}/v2/ 获取认证入口" >&2
    exit 1
fi

token_body=$(curl -fsS -u "${ACR_USER}:${ACR_PASS}" \
    "${realm}?service=${service}&scope=repository:${FULL}:pull")
# 带认证时字段名是 token，匿名是 access_token，两种都兜住
token=$(printf '%s' "$token_body" | json_field token || true)
if [ -z "$token" ]; then
    token=$(printf '%s' "$token_body" | json_field access_token || true)
fi
if [ -z "$token" ]; then
    echo "错误：获取 token 失败（检查 ACR_USER / ACR_PASS）" >&2
    exit 1
fi

# 2) 列标签
raw=$(curl -fsS -H "Authorization: Bearer ${token}" \
    "https://${REGISTRY}/v2/${FULL}/tags/list?n=1000")
all=$(printf '%s' "$raw" | sed -n 's/.*"tags":\[\(.*\)\].*/\1/p' | tr ',' '\n' | tr -d ' "')
if [ -z "$all" ]; then
    echo "仓库 ${FULL} 当前没有标签。"
    exit 0
fi

versions=$(printf '%s\n' "$all" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -Vr || true)
others=$(printf '%s\n' "$all" | grep -Ev '^[0-9]+\.[0-9]+\.[0-9]+$' || true)

total=$(printf '%s\n' "$all" | wc -l)
vcount=$(printf '%s\n' "${versions:-}" | grep -c . || true)

echo "仓库：${REGISTRY}/${FULL}"
echo "共 ${total} 个标签（版本 ${vcount} 个）"
echo

keep_list=$(printf '%s\n' "${versions:-}" | grep . | head -n "$KEEP" || true)
drop_list=$(printf '%s\n' "${versions:-}" | grep . | tail -n +"$((KEEP + 1))" || true)

echo "保留（最新 ${KEEP} 个版本）："
if [ -n "$keep_list" ]; then
    printf '%s\n' "$keep_list" | sed 's/^/  - /'
else
    echo "  （无）"
fi
echo

if [ -n "$drop_list" ]; then
    echo "需要删除（版本数超出 ${KEEP}）："
    printf '%s\n' "$drop_list" | sed 's/^/  - /'
else
    echo "版本数未超出 ${KEEP}，无需清理。"
fi

if [ -n "$others" ]; then
    echo
    echo "非版本标签（latest 应保留；短 SHA 等别名可删）："
    printf '%s\n' "$others" | sed 's/^/  - /'
fi

echo
echo "删除方式：ACR 控制台 → 命名空间 ${NAMESPACE} → 仓库 ${REPO} → 标签 → 删除。"
echo "注意：删除不可逆，确认服务器 compose 未引用该标签。"
