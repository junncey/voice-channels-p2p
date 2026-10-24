# 语音频道 · Voice Channels P2P

自托管的**持久化语音频道**服务：管理员在网页后台创建频道并配置主持人，游客点开链接即可加入语音与文字聊天。语音与聊天走浏览器间 **P2P 直连**（mesh WebRTC + DataChannel），服务器只做信令与频道管理，另为文字聊天留存一份时长可配置的历史记录供新进成员查看。

> 本项目基于开源项目 [MiroTalk P2P](https://github.com/miroslavpejic85/mirotalk)（AGPL-3.0）深度定制：移除视频/白板/文件等会议功能，重写全部前端，新增持久化频道、网页管理后台与按频道配置的主持人体系。

## 来源与版本

| 项目 | 说明 |
| --- | --- |
| 本仓库 | [junncey/voice-channels-p2p](https://github.com/junncey/voice-channels-p2p) |
| 上游仓库 | [miroslavpejic85/mirotalk](https://github.com/miroslavpejic85/mirotalk) — MiroTalk P2P，作者 Miroslav Pejic |
| 分叉基线 | 上游 `master` @ [`0a496f8`](https://github.com/miroslavpejic85/mirotalk/commit/0a496f8313cc313f4d5443b14470adb64de811b5)（2026-09-28，`package.json` v2.0.30） |
| 版本号 | 本仓库自 **v1.0.0** 起独立编号，与上游版本号无对应关系 |
| 许可 | AGPL-3.0；原始版权归 Miroslav Pejic，衍生部分声明见 [NOTICE](NOTICE) |

> 本仓库是 MiroTalk P2P 源码基础上的**衍生作品**（derivative work），并非上游官方分支。上游的 `mirotalk/p2p` 镜像与本项目无关，本项目镜像为 `b1at-public/voice-channels`（公开命名空间，匿名可拉取）。

## 功能

- **持久化频道** — 频道保存在 `app/src/channels.json`，重启不丢；链接永久有效（`/c/<id>`）
- **网页管理后台** — `/admin` 创建/编辑/删除频道（删除时在线成员会被移出），设置公开性、人数上限、频道加入密码（可选，游客进房需输入；主持人凭账号豁免；scrypt 哈希存储，随时可改可清）、主持人账号密码（scrypt 哈希存储）；「服务器设置」弹窗可开关临时房间、调整防滥用配额与聊天记录保留时长（持久化，重启不丢）；后台可查看并删除进行中的临时房间；首页不展示入口，管理员直接访问路径
- **主持人（按频道配置）** — 主持人在频道页登录后获得：静音成员、移出成员、重命名成员（修改其录入昵称，全员同步且对其本人持久生效）、锁定频道（禁止新加入）；登录凭据在浏览器本地持久化（默认 30 天），重开浏览器进频道自动恢复主持人身份，过期自动降级为游客加入；首页「清除全部信息」可一并清除
- **游客直接加入** — 首次打开链接输入昵称（仅请求麦克风权限）；此后昵称与全部配置（音频设置、对每个成员的音量）保存在本浏览器，进任何频道自动直入、免弹窗；带密码的频道首次需输入密码，之后同样自动直入（密码仅存本浏览器，首页「清除全部信息」可一并清除）；首页可一键清除（仅用户名 / 用户名+全部配置）
- **频道页布局** — 左侧语音成员列表（说话光环动效、麦克风状态），右侧文字对话窗口；移动端自动上下堆叠
- **深浅色主题** — 首页顶栏一键切换深色（默认）/浅色（QQ 白蓝风格），选择保存在本浏览器并全站跟随，「清除全部信息」不会重置主题
- **QQ 风格聊天** — 气泡式消息（对方在左带头像昵称、自己在右）、居中时间分隔条（间隔超 5 分钟才显示）、自定义头像：设置中上传图片自动裁剪为方形，仅存本浏览器，实时同步给频道内成员（历史消息头像一并更新）；输入框支持多行输入（随内容自动增高），发送键可在发送按钮旁的下拉菜单配置：按 Enter 键发送 / 按 Ctrl + Enter 键发送（QQ 习惯），中文输入法组词时的 Enter 不会误发送
- **临时房间** — 首页一键创建（或直接访问任意 `/c/<id>`）：内存中即开即用、不入库不占频道数，可分享链接给朋友；最后一人离开即自动销毁；无主持人体系；超管可在管理后台随时开关此功能并调整防滥用配额（`TEMP_ROOMS_ENABLED` 仅作为首次启动的初始值，之后以后台设置为准）：临时房间总数上限、每 IP 同时保有数（默认 3，IPv6 按 /64 归一计数，防单人多开刷房）、每 IP 创建频率（默认 10 分钟 5 次，防建了就走的循环刷房）、单连接同时加入频道数（默认 2）；配额超限时客户端收到明确提示，已存在的房间不受影响仍可加入；后台也会列出进行中的临时房间并可删除（成员会被移出）；已存在的临时房间在关闭开关后保留至自然清空
- **聊天记录历史** — 文字与图片按后台配置的时长（默认 24 小时，0 = 不保留）留存于服务器，新加入的成员进频道即可看到历史消息（图片原样重现为合并气泡，可放大/保存）并以「以上为历史消息」分隔；进入时只拉取最近 10 条，往上滚到顶部自动按时间游标逐页加载更早的消息（顶部显示「正在加载更早的消息…」，到底显示「没有更早的消息了」），加载不打断滚动位置、时间分隔条自动接续；保留时长在管理后台「服务器设置」随时可调，调短/清零后由后台定期清理任务生效；删除频道时历史一并清除；临时房间的历史仅存内存、随房间销毁
- **图片消息** — 聊天中可直接 **Ctrl+V 粘贴剪贴板图片**或点图片按钮选择文件；图片先挂在输入框中，可继续补充文字或更多图片后一起发送，文字与多图合并为同一气泡（多图自动网格排布）；自动压缩（GIF 动图保留原图）后经 DataChannel 分块 P2P 传输，点击可放大/保存
- **音频设置** — 麦克风/扬声器设备选择、输入电平表、输入音量 0–200%（本地增益即时生效）、噪声抑制/回声消除/自动增益开关、**高保真（音乐）模式**（一键关闭三个处理开关，Opus 提升至 192kbps 立体声发送，分享音乐不发糊；语音模式默认 64kbps + DTX 静默省流）、按键通话（按住 V 说话）、扬声器音量、测试扬声器、测试麦克风（实时回环，约半秒延迟）；设置按浏览器本地记忆
- **单独音量** — 每个成员可独立调节 0–300%（Web Audio 增益，超过 100% 放大；不支持的浏览器自动回退并封顶 100%），并按昵称跨频道、跨会话记忆
- **操作音效** — 成员加入/离开、收到新消息、开关麦克风时的提示音（音效文件取自上游 MiroTalk `/sounds` 库）；总开关 + 音效音量 + 每个事件独立开关与音效选择，也可上传自己的音频文件作为任意事件的提示音（仅保存在本浏览器，不发送给任何人）；设置按浏览器本地记忆
- **纯 P2P** — 语音走 mesh WebRTC，聊天与图片走 DataChannel 直发；服务器不为媒体中继，仅按后台配置的时长留存聊天历史（发送端自愿同步的一份副本）
- **语音链路自愈** — TURN 服务（coturn）重启或网络抖动导致链路断裂时自动恢复，无需手动刷新：断链 5 秒宽限期后自动尝试 ICE restart（每链路独立、3/6/12 秒退避、双方按 socket.id 仲裁避免协商冲突），仍失败则自动重连信令整体重建链路（聊天消息保留）；恢复失败时成员卡片显示「连接中断」徽章并弹出顶部横幅，可一键重新加入或刷新
- **链路可见** — 成员卡片上标注「P2P」或「中转」并直接显示实测延迟（如「P2P 45ms」）：读取 ICE 选中候选对判断打洞是否成功，每 5 秒刷新（ICE restart 切换路径也会跟上），悬停可看两端候选类型（host/srflx/prflx/relay）、RTT、丢包率、抖动与接收码率；丢包持续超阈值时卡片显示「网络不稳」徽章。仅本机可见，服务器无从得知
- **移动端防息屏** — 连麦期间自动申请屏幕常亮（Wake Lock API），切后台回来自动重新持有；锁屏导致的掉线大幅减少，不支持的浏览器静默降级
- **中转自动升级** — ICE 只协商出 TURN 中转时（首次打洞慢、NAT 绑定未就绪等），持续 12 秒仍在中转就自动重跑一次 ICE restart 重新打洞，成功即切回「P2P」直连，音频与聊天不中断（聊天 DataChannel 保留）；双方按 socket.id 仲裁，只有一侧发起；最多 2 次、45 秒窗口内放弃并保持中转，打洞确实不可用（对称 NAT、UDP 被封）时不会反复重协商
- **离开确认** — 通话中关闭标签页、刷新或按浏览器返回，会弹出浏览器原生的「离开此网站？」确认（文案由浏览器本地化），取消后通话照常不受影响；点页内「离开」按钮、或从版本提示条刷新（已先确认过）都不会再问第二次。确认真正离开后由 `pagehide` 统一断连、关麦，iOS 上被划掉标签页也走同一路径
- **版本更新提示** — 页面开着时若服务端发布了新前端（`public/` 内容指纹变化，无需手动改版本号），每 5 分钟自动检测（切回标签页立即检测），顶部出现一条提示栏（占位不遮挡内容、不打断通话），可一键刷新或关闭（同一版本关闭后不再打扰）；页面 HTML 里带着自己的构建指纹，发布恰好卡在打开页面那一刻也不会漏报；通话中点击刷新会先确认。纯后端更新不会提示刷新
- 前端为原生 HTML/CSS/JS（ES Modules），无构建步骤，中文优先（可加 `?lang=en`）

## 快速开始

```bash
cp .env.template .env      # 编辑 .env，至少设置 CHANNEL_ADMIN_PASSWORD / CHANNEL_ADMIN_JWT_SECRET
npm install
npm start                  # http://localhost:3000
```

1. 打开 `http://localhost:3000/admin`，用 `CHANNEL_ADMIN_PASSWORD` 登录
2. 新建频道：填写名称、人数上限（语音 mesh 建议 ≤ 8）、主持人账号密码；频道 ID 可留空自动生成（也可自定义链接后缀）
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

镜像同时推送到两个仓库，**ACR 用于部署（国内快）、GHCR 用于归档（可自动清理）**：

```bash
# ACR（公开命名空间，匿名可拉，部署用这个）
docker pull crpi-a3ur4k2rueat32kn.cn-beijing.personal.cr.aliyuncs.com/b1at-public/voice-channels:1.1.0

# GHCR（GitHub 归档，备份/海外用）
docker pull ghcr.io/junncey/voice-channels:1.1.0
```

本地自行构建：

```bash
docker build -t voice-channels:latest .
docker run -d -p 3000:3000 \
  -v ./.env:/src/.env:ro \
  -v ./app/src/channels.json:/src/app/src/channels.json \
  -v ./app/src/chat_history:/src/app/src/chat_history \
  --name voice-channels voice-channels:latest
```

必须挂载 `channels.json` 与 `chat_history/`，否则容器重建后频道注册表 / 聊天记录会丢失（compose 模板见 `docker-compose.template.yml`）。

### 标签策略

| 项 | 约定 |
| --- | --- |
| 每次发布 | 只推「版本号 + `latest`」两个标签，**不推短 SHA 标签** |
| 版本保留 | 两边都只保留最新 **3** 个版本标签 |
| ACR 清理 | 个人版无删除 API，**手动**在控制台删；每次发布会把待删清单写进运行摘要 |
| GHCR 清理 | **全自动**：`prune-ghcr` 任务在构建后调用 `scripts/ghcr-prune.py --apply` 删除超出 3 个的旧版本 |
| 部署 | 一律使用固定版本标签（如 `:1.1.0`），不用 `latest`，避免隐式升级 |
| 本地查标签 | `ACR_USER=… ACR_PASS=… ./scripts/acr-tags.sh`（只读） |

> ACR 个人版在**产品层面**就封了删除：Registry 的 `DELETE` 返回 `UNAUTHORIZED … Action:"delete"`，且官方《个人版与企业版实例差异化说明》明确写「**个人版不对外提供 OpenAPI 接口**」，`DeleteRepoTag` 需要企业版实例的 `InstanceId`/`RepoId`，生命周期规则同样仅企业版可用。因此 GitHub Actions 只能推送、无法删除，清理只能在控制台手动执行；发布流水线每次会把 `scripts/acr-tags.sh` 的审计结果写进运行摘要，提示该删哪几个标签。
>
> GHCR 不受此限制——GitHub Packages 提供完整的删除 API，`prune-ghcr` 任务因此可以真正做自动清理。GHCR 包默认沿用仓库可见性（本仓库为 public），已验证匿名可拉取。

### 发布流程

1. **改版本号** — `package.json` 与 `package-lock.json`（两处 `version`）
2. **本地校验** — `npm test`
3. **打 tag 推送** — tag 形如 `v*` 会触发构建，请勿用 `git push --tags`
   ```bash
   git tag -a v1.0.1 -m "v1.0.1 — …" && git push origin v1.0.1
   ```
4. **写发布说明** — 等构建完成后执行（`DIGEST` 从 GHCR 读取），再创建 Release
   ```bash
   CHANGES=$'- 新增…\n- 修复…' PREV_VERSION=1.0.0 \
     ./scripts/release-notes.sh 1.0.1 > body.md
   gh release create v1.0.1 --title "v1.0.1 — …" --notes-file body.md
   ```
   模板见 [`.github/release-template.md`](.github/release-template.md)。脚本自动填 `DIGEST`（GHCR 匿名读取，ACR 与 GHCR 同 digest）、`BUILD_ID`（前端内容指纹）、`TEST_COUNT`（`mocha --dry-run` 统计）；`IMAGE_SIZE` / `BUILD_ID` / `TEST_COUNT` 可用环境变量覆盖。镜像尚未推送时会提示 digest 待回填，重跑即可。
5. **服务器升级** — compose 改固定版本号后 `docker compose pull && docker compose up -d`

> ⚠️ 工作区有未提交改动时，脚本会告警：此时自动算出的 `BUILD_ID` 只代表当前工作区，不代表任何已发布版本。补发旧版本的说明请显式传 `BUILD_ID`，或直接取线上 `/api/version` 的值。

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
  chatStore.js             聊天历史留存（chat_history/ 按保留时长原子写盘清理，文字+图片）
  config.js                环境变量集中读取（由 config.template.js 生成）
  channels.json            运行时数据（gitignore，Docker 需挂载卷）
  chat_history/            运行时聊天记录（gitignore，Docker 需挂载卷）
```

- **信令**：`join` → 服务端对每对成员互发 `addPeer` → 新成员发起 offer → `relaySDP`/`relayICE` 纯转发
- **聊天**：每条连接上的 `mirotalk_chat_channel` DataChannel 直发，实时消息仅在线成员可见；发送端另向服务器 `chat` 事件同步一份副本用于历史留存（图片逐张单独上报、服务端组装，避免超出单包上限），新成员 join 时经 `chatHistory` 事件下发（时长可配，见 chatStore.js）
- **主持人判定**：仅凭 `/api/host/login` 签发的本频道 host JWT；「首人即主持人」已废除
- **人数上限**：服务端按频道 `maxParticipants` 硬校验（主持人不受限）

## 测试

```bash
npm test        # mocha：channelStore/chatStore 单测 + validate/xss 回归
```

## 许可

[AGPL-3.0](LICENSE)。本项目继承自 MiroTalk P2P（原始作者 [Miroslav Pejic](https://github.com/miroslavpejic85)），
衍生部分的版权与改动声明见 [NOTICE](NOTICE)。

AGPL-3.0 第 13 条要求：若通过网络对外提供服务，须向使用者提供对应源码。
本项目的源码地址为 <https://github.com/junncey/voice-channels-p2p>。
