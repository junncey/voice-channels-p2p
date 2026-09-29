# 语音频道 · Voice Channels（基于 MiroTalk P2P 的语音房定制版）

自托管的**持久化语音频道**服务：管理员在网页后台创建频道并配置主持人，游客点开链接即可加入语音与文字聊天。媒体与聊天全部走浏览器间 **P2P 直连**（mesh WebRTC + DataChannel），服务器只做信令与频道管理，不留存任何聊天内容。

> 本项目基于开源项目 [MiroTalk P2P](https://github.com/miroslavpejic85/mirotalk)（AGPLv3）深度定制：移除视频/白板/文件等会议功能，重写全部前端，新增持久化频道、网页管理后台与按频道配置的主持人体系。

## 功能

- **持久化频道** — 频道保存在 `app/src/channels.json`，重启不丢；链接永久有效（`/c/<id>`）
- **网页管理后台** — `/admin` 创建/编辑/删除频道，设置公开性、人数上限、主持人账号密码（scrypt 哈希存储）
- **主持人（按频道配置）** — 主持人在频道页登录后获得：静音成员、移出成员、锁定频道（禁止新加入）
- **游客直接加入** — 打开链接 → 输入昵称 → 仅请求麦克风权限即可进入；麦克风不可用时可「仅文字模式」加入
- **频道页布局** — 左侧语音成员列表（说话光环动效、麦克风状态），右侧文字对话窗口；移动端自动上下堆叠
- **纯 P2P** — 语音走 mesh WebRTC，聊天走 DataChannel，服务器不中继、不存储聊天记录
- 前端为原生 HTML/CSS/JS（ES Modules），无构建步骤，中文优先（可加 `?lang=en`）

## 快速开始

```bash
cp .env.template .env      # 编辑 .env，至少设置 CHANNEL_ADMIN_PASSWORD / CHANNEL_ADMIN_JWT_SECRET
npm install
npm start                  # http://localhost:3000
```

1. 打开 `http://localhost:3000/admin`，用 `CHANNEL_ADMIN_PASSWORD` 登录
2. 新建频道：填写 ID（链接后缀）、名称、人数上限（语音 mesh 建议 ≤ 8）、主持人账号密码
3. 公开频道显示在首页；隐藏频道仅限通过 `/c/<id>` 链接访问
4. 主持人在频道页点「主持人登录」输入账号密码获得主持人权限

## 环境变量（频道相关）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `CHANNEL_ADMIN_PASSWORD` | 管理后台登录密码（**留空则 /admin 与 /api/admin/* 全部 404**） | 空 |
| `CHANNEL_ADMIN_JWT_SECRET` | 管理/主持人 JWT 签名密钥（留空则后台禁用） | 空 |
| `CHANNEL_ADMIN_JWT_EXP` | 令牌有效期 | `24h` |
| `DEFAULT_CHANNEL_MODERATOR` | 未配置主持人的频道的共享主持人密码（留空禁用） | 空 |
| `AUTO_INIT_CHANNELS` | 首次启动自动创建空 channels.json | `true` |

其余通用配置（端口、STUN/TURN、CORS、IP 白名单等）见 `.env.template`。

## Docker

```bash
docker build -t mirotalk/p2p:latest .
docker run -d -p 3000:3000 \
  -v ./.env:/src/.env:ro \
  -v ./app/src/channels.json:/src/app/src/channels.json \
  --name mirotalk mirotalk/p2p:latest
```

必须挂载 `channels.json`，否则容器重建后频道注册表会丢失（compose 模板见 `docker-compose.template.yml`）。

## 架构

```
public/                     全新前端（无构建）
  index.html / channel.html / admin.html / 404.html
  css/  tokens(设计变量) base(通用组件) + 每页样式
  js/core/   api(REST) webrtc(mesh+DataChannel) audio(说话检测) chat i18n utils
  js/pages/  index channel admin 控制器
  lang/      zh / en 词典

app/src/
  server.js                路由 + REST + Socket.IO 信令（join/addPeer/relaySDP/relayICE…）
  channelStore.js          持久化频道注册表（原子写盘 + scrypt 哈希）
  config.js                环境变量集中读取（由 config.template.js 生成）
  channels.json            运行时数据（gitignore，Docker 需挂载卷）
```

- **信令**：`join` → 服务端对每对成员互发 `addPeer` → 新成员发起 offer → `relaySDP`/`relayICE` 纯转发
- **聊天**：每条连接上的 `mirotalk_chat_channel` DataChannel 直发，仅在线成员可见（不存历史）
- **主持人判定**：仅凭 `/api/host/login` 签发的本频道 host JWT；「首人即主持人」已废除
- **人数上限**：服务端按频道 `maxParticipants` 硬校验（主持人不受限）

## 测试

```bash
npm test        # mocha：channelStore 单测 + validate/xss 回归
```

## 许可

AGPL-3.0（继承自 MiroTalk P2P，作者 [Miroslav Pejic](https://github.com/miroslavpejic85)）。
