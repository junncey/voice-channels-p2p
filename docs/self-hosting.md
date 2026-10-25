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

