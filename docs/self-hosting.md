# Self-Hosting（本衍生版）

上游 MiroTalk 的通用文档：

- Self-hosting 指南：[https://docs.mirotalk.com/mirotalk-p2p/self-hosting/](https://docs.mirotalk.com/mirotalk-p2p/self-hosting/)
- 自动化脚本：[https://docs.mirotalk.com/scripts/about/](https://docs.mirotalk.com/scripts/about/)

本仓库的部署要点（以仓库内文档为准）：

- **快速开始 / 环境变量**：见 [README.md](../README.md)「快速开始」「环境变量」与 [`.env.template`](../.env.template)（管理密码、JWT 密钥、STUN/TURN、临时房间等）
- **TURN 服务器**：coturn 部署与公网推荐的 REST/HMAC 临时凭证模式（`TURN_SERVER_SECRET`）见 [coturn.md](coturn.md)
- **Docker**：必须挂载 `channels.json` 与 `chat_history/` 卷（compose 模板见 [`docker-compose.template.yml`](../docker-compose.template.yml)）；跨实例迁移可用管理后台「下载备份」
- **管理后台**：`/admin`（需先配置 `CHANNEL_ADMIN_PASSWORD` + `CHANNEL_ADMIN_JWT_SECRET`，未配置时整站 404）

---

## TLS 与部署形态

服务器启动时按证书存在性选择协议（`app/src/server.js`）：

- **无证书（默认）**：端口只服务 HTTP。这是推荐形态——由反向代理（nginx / Caddy / Traefik 等）在容器前终止 TLS；`docker-compose.template.yml` 里注释掉的 Traefik + Let's Encrypt 段即为此形态的示例。`TRUST_PROXY=true` 可让 Express 信任代理头（限流按真实客户端 IP 计数）。
- **`app/ssl/key.pem` + `app/ssl/cert.pem` 同时存在**：端口只服务 HTTPS（原生 TLS，适合不经反代直接暴露）。Docker 部署把两个证书文件挂载到 `/src/app/ssl/` 即可。

注意：同一端口**不再**同时接受 HTTP 与 HTTPS（上游 `httpolyglot` 的同端口双协议行为已随该依赖移除而退役）；上游随仓库分发的演示自签名证书也已删除——需要原生 HTTPS 请挂载真实证书（生成方法见 `app/ssl/README.md`）。浏览器 `getUserMedia` 要求安全上下文：直连裸 HTTP 仅在 `localhost` 下可用麦克风，公网裸 HTTP 无法使用。

---

## 备份与恢复

管理后台提供三种数据操作，覆盖 `channels.json` 与 `chat_history/` 的全部持久化状态：

- **下载备份**：打包当前频道注册表与聊天记录为 `tar.gz`（流式生成，不占用内存）。
- **恢复备份**：上传一个「下载备份」产出的 `tar.gz`，校验通过后整体替换当前数据（校验失败不会动任何文件）。恢复是**全量语义**——备份里没有的频道，其聊天记录会被清掉；建议在无人在线时执行。
- **定时滚动备份**：设置环境变量 `CHANNEL_BACKUP_INTERVAL_HOURS`（如 `24`）后，服务器按间隔自动在 `CHANNEL_BACKUP_DIR`（默认 `app/src/backups`）写一份归档并只保留最新 `CHANNEL_BACKUP_KEEP`（默认 7）份。Docker 部署建议把该目录一并挂载出来。

聊天记录在磁盘上为按频道一文件的 JSONL 追加日志（`chat_history/<id>.jsonl`），旧版本的 `*.json` 单文件格式会在首次读取时自动迁移；两者在备份/恢复中都被支持。

## 审计日志

成员进出（join/leave/掉线宽限过期）、主持人/管理员踢人、频道增删改、备份与恢复操作都会记录到 `app/src/audit.jsonl`（JSONL，超过 5MB 自动轮转为 `.1`）。管理后台「审计日志」面板可直接查看最近 200 条；也可用 `VC_AUDIT_FILE` 重定向路径（集成测试即用此法隔离）。Docker 部署时该文件在容器内，若要保留请先 `touch app/src/audit.jsonl` 再按模板挂载单文件（模板已给出）。

## 统计

管理后台「统计」面板展示注册频道数、临时房间数、在线成员总数、聊天记录文件数与磁盘占用、保留时长、运行时长与版本，并列出当前活跃频道（按在线人数排序）。数据来自内存状态与文件大小汇总，不做全量磁盘扫描。
