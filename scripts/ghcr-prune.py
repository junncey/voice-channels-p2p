#!/usr/bin/env python3
"""GHCR 容器包版本清理：只保留最新 N 个发布版本。

与 ACR 不同，GitHub Packages 提供完整的删除 API，所以 GHCR 这边可以
在 Actions 里全自动清理，不需要任何人工操作。

用法：
    GH_TOKEN=xxx python3 scripts/ghcr-prune.py --owner junncey --package voice-channels
    GH_TOKEN=xxx python3 scripts/ghcr-prune.py --owner junncey --package voice-channels --apply

默认 dry-run（只打印计划），加 --apply 才真正删除。
版本按语义化版本号 x.y.z 排序；没有 x.y.z 标签的版本（例如只有 latest）
不参与清理，避免误删。
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def call(url, token, method="GET"):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return (json.loads(raw) if raw else None), resp.headers.get("Link", "")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        print(f"HTTP {exc.code} {method} {url}\n{body}", file=sys.stderr)
        sys.exit(1)


def next_link(link_header):
    for part in (link_header or "").split(","):
        if 'rel="next"' in part:
            return part.split(";")[0].strip().strip("<>")
    return None


def list_versions(owner, package, token):
    url = f"{API}/users/{owner}/packages/container/{package}/versions?per_page=100"
    out = []
    while url:
        data, link = call(url, token)
        out.extend(data or [])
        url = next_link(link)
    return out


def version_key(ver):
    tags = (ver.get("metadata") or {}).get("container", {}).get("tags") or []
    groups = []
    for tag in tags:
        m = SEMVER.match(tag)
        if m:
            groups.append(tuple(int(x) for x in m.groups()))
    if not groups:
        return None
    return max(groups)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default=os.environ.get("GHCR_OWNER"))
    ap.add_argument("--package", default=os.environ.get("GHCR_PACKAGE"))
    ap.add_argument("--keep", type=int, default=int(os.environ.get("KEEP", "3")))
    ap.add_argument("--apply", action="store_true", help="真正删除（默认只打印计划）")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not (args.owner and args.package and token):
        print("缺少参数：需要 --owner、--package 与 GH_TOKEN 环境变量", file=sys.stderr)
        return 2

    versions = list_versions(args.owner, args.package, token)
    if not versions:
        print(f"GHCR 包 {args.owner}/{args.package} 暂无版本（可能还没推送成功）。")
        return 0

    releases = [(version_key(v), v) for v in versions]
    releases = [(k, v) for k, v in releases if k]
    releases.sort(key=lambda kv: (kv[0], kv[1].get("created_at", "")), reverse=True)

    keep = releases[: args.keep]
    drop = releases[args.keep :]

    def label(ver):
        tags = (ver.get("metadata") or {}).get("container", {}).get("tags") or []
        return ",".join(tags) or ver.get("name", "")[:19]

    print(f"GHCR 包：ghcr.io/{args.owner}/{args.package}")
    print(f"共 {len(versions)} 个版本（含版本号标签的 {len(releases)} 个），保留最新 {args.keep} 个")
    print("保留：", " ".join(label(v) for _, v in keep) or "（无）")
    if not drop:
        print("无需清理。")
        return 0

    print("待删除：")
    for key, ver in drop:
        print(f"  - {label(ver)}  (id={ver['id']}, created={ver.get('created_at', '')[:10]})")

    if not args.apply:
        print("\n[dry-run] 未删除任何版本；加 --apply 执行。")
        return 0

    failed = 0
    for _, ver in drop:
        url = f"{API}/users/{args.owner}/packages/container/{args.package}/versions/{ver['id']}"
        try:
            call(url, token, method="DELETE")
            print(f"已删除 {label(ver)}")
        except SystemExit:
            failed += 1
    if failed:
        print(f"\n{failed} 个版本删除失败（见上方 HTTP 错误）", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
