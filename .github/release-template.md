<!--
Release 说明模板

标题格式：  v{{VERSION}} — <一句话主题>

用法（二选一）：
  1) 自动填充（推荐）
       CHANGES=$'- 新增聊天历史分页\n- 修复…' PREV_VERSION=1.0.0 \
         ./scripts/release-notes.sh 1.0.1 > body.md
       gh release create v1.0.1 --title "v1.0.1 — …" --notes-file body.md

  2) 手动复制本文件，替换所有 {{...}} 占位符后粘贴到 GitHub Release 编辑框。

占位符：
  {{VERSION}}     版本号（不带 v，如 1.0.1）
  {{DATE}}        发布日期（YYYY-MM-DD）
  {{DIGEST}}      镜像 digest（ACR 与 GHCR 相同）
  {{BUILD_ID}}    前端内容指纹（node -e "require('./app/src/version').computeBuildId('./public')"）
  {{TEST_COUNT}}  npm test 通过数
  {{PREV_VERSION}} 上一版本号（首个版本可写「独立化之前」）
  {{CHANGES}}     与上一版本的差异清单（Markdown 列表）
  {{IMAGE_SIZE}}  镜像体积

固定段落（基线、功能清单、标签策略、部署、许可）只在这些情况修改：
上游基线升级、功能增删、发布策略调整。其余版本仅替换占位符。
-->

自托管的**持久化语音频道**服务：管理员在网页后台创建频道并配置主持人，游客点开链接即可加入语音与文字聊天。语音走 mesh WebRTC，聊天与图片走 DataChannel，均为浏览器间 **P2P 直连**；服务器只做信令与频道管理，另为文字聊天留存一份保留时长可在后台配置的历史副本。

### 基线

| 项 | 值 |
| --- | --- |
| 上游仓库 | [miroslavpejic85/mirotalk](https://github.com/miroslavpejic85/mirotalk)（MiroTalk P2P，作者 Miroslav Pejic） |
| 分叉基线 | `master` @ [`0a496f8`](https://github.com/miroslavpejic85/mirotalk/commit/0a496f8313cc313f4d5443b14470adb64de811b5)（2026-09-28，`package.json` v2.0.30） |
| 版本号 | 本仓库自 **v1.0.0** 起独立编号，与上游 `2.0.30` 序列无对应关系 |
| 许可 | AGPL-3.0；衍生作品声明与改动清单见 [NOTICE](https://github.com/junncey/voice-channels-p2p/blob/main/NOTICE) |

> 本仓库是 MiroTalk P2P 源码基础上的**衍生作品**（derivative work），并非上游官方分支。上游的 `mirotalk/p2p` 镜像与本项目无关。

### 功能

- **持久化频道** — 频道存于 `app/src/channels.json`，重启不丢，链接永久有效（`/c/<id>`）
- **网页管理后台** — `/admin` 创建 / 编辑 / 删除频道，设置公开性、人数上限、加入密码、主持人账号；「服务器设置」可调临时房间开关、防滥用配额与聊天保留时长，重启不丢
- **按频道配置的主持人** — 静音、移出、重命名成员，锁定频道禁止新加入；凭据本地持久化 30 天，过期自动降级为游客
- **游客免弹窗直入** — 昵称与全部偏好（音频设置、逐成员音量）存于本浏览器，再次打开同一链接直接进房
- **临时房间** — 首页一键创建，内存中即开即用、不入库，最后一人离开即销毁；每 IP 并发数与创建频率均有配额
- **聊天记录** — 文字与图片按配置时长（默认 24h）留存，新成员进房可见历史；图片原样重现为合并气泡
- **图片消息** — Ctrl+V 粘贴或选择文件，可附文字一起发送，自动压缩后经 DataChannel 分块传输
- **音频设置** — 设备选择、输入电平表、0–200% 增益、降噪 / 回声消除 / 自动增益、按键通话、扬声器与麦克风测试
- **单独音量** — 逐成员 0–300% 调节，按昵称跨频道、跨会话记忆
- **QQ 风格聊天** — 气泡式消息、时间分隔条、自定义头像（仅存本地并实时同步）、Enter / Ctrl+Enter 可选、中文输入法不误发
- **语音链路自愈** — TURN 重启或网络抖动导致断链时自动 ICE restart，仍失败则重建信令，无需手动刷新
- **中转自动升级** — 落在 TURN 中转时自动重跑 ICE restart 重新打洞，成功即切回 P2P 直连（最多 2 次 / 45 秒，不影响音频与聊天）
- **离开确认** — 通话中关标签页、刷新、按返回时弹浏览器原生确认；取消后通话继续，页内「离开」与版本条刷新不会再问第二次
- **版本更新提示** — 前端内容指纹变化即提示刷新（每 5 分钟检测，切回标签页立即检测），不打断通话
- **纯 P2P** — 服务器不为媒体中继，仅按配置时长留存聊天历史副本

### 镜像

两个 registry 内容完全一致（同一 digest），均**匿名可拉取、无需 `docker login`**：

| Registry | 镜像 | 用途 |
| --- | --- | --- |
| 阿里云 ACR（公开命名空间） | `b1at-public/voice-channels:{{VERSION}}` | 部署（国内拉取快） |
| GitHub GHCR | `ghcr.io/junncey/voice-channels:{{VERSION}}` | 归档 / 海外节点 |

```bash
# 阿里云 ACR
docker pull crpi-a3ur4k2rueat32kn.cn-beijing.personal.cr.aliyuncs.com/b1at-public/voice-channels:{{VERSION}}

# GitHub GHCR
docker pull ghcr.io/junncey/voice-channels:{{VERSION}}
```

- **digest**：`{{DIGEST}}`
- 平台 `linux/amd64`，镜像 {{IMAGE_SIZE}}，基础镜像 `node:24-alpine`

### 部署

```yaml
services:
  voice-channels:
    image: crpi-a3ur4k2rueat32kn.cn-beijing.personal.cr.aliyuncs.com/b1at-public/voice-channels:{{VERSION}}
    container_name: voice-channels
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./.env:/src/.env:ro
      - ./app/src/channels.json:/src/app/src/channels.json
      - ./app/src/chat_history:/src/app/src/chat_history
      - ./app/src/audit.jsonl:/src/app/src/audit.jsonl
      - ./app/src/backups:/src/app/src/backups
```

必须挂载 `channels.json` 与 `chat_history/`，否则容器重建后频道注册表与聊天历史会丢失。`audit.jsonl`（审计日志）与 `backups/`（定时备份）自 v1.3.0 起可选挂载：审计文件需先在宿主 `touch app/src/audit.jsonl` 并归 `1000:1000`，否则容器内不可写。完整模板（含 Traefik 反代示例）见 [`docker-compose.template.yml`](https://github.com/junncey/voice-channels-p2p/blob/main/docker-compose.template.yml)。

启动后访问 `/admin`，用 `.env` 中的 `CHANNEL_ADMIN_PASSWORD` 登录并创建频道（`CHANNEL_ADMIN_JWT_SECRET` 未设置时后台整体禁用）。

### 标签策略

| 项 | 约定 |
| --- | --- |
| 每次发布 | 只推「版本号 + `latest`」两个标签，不推短 SHA 标签 |
| 版本保留 | 最新 **3** 个版本 |
| 清理 | GHCR 由 CI 自动删除超出部分；ACR 个人版不开放删除 API，需在控制台手动执行，流水线每次把待删清单写进运行摘要 |
| 部署 | 一律使用固定版本号（如 `:{{VERSION}}`），不用 `latest`，避免隐式升级 |

### 本版本改动

对比基线：`{{PREV_VERSION}}`

{{CHANGES}}

### 验证

- `npm test` — **{{TEST_COUNT}} passing**
- `GET /api/version` → `{"version":"{{VERSION}}","build":"{{BUILD_ID}}"}`
- 容器重建后 `/admin` 与频道页正常，频道注册表、聊天历史挂载完好
- 两个 registry 均以空凭证目录（`DOCKER_CONFIG` 指向空目录）实测匿名拉取成功

### 发布信息

- 发布日期：{{DATE}}
