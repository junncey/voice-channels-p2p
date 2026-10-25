# Install Coturn STUN/TURN server

### What are STUN and TURN in the context of network communication?

[https://docs.mirotalk.com/coturn/stun-turn/](https://docs.mirotalk.com/coturn/stun-turn/)

### How can I set up and configure my own STUN and TURN servers?

[https://docs.mirotalk.com/coturn/installation/](https://docs.mirotalk.com/coturn/installation/)

---

## 临时凭证模式（use-auth-secret，推荐公网部署）

静态 TURN 账号密码会随每次 `join` 下发给浏览器，长期有效、泄露即被白嫖中转流量。临时凭证模式让 coturn 与本服务共享一个密钥，服务端为每个进程铸造**短时效**凭据（用户名 = 过期时间戳，密码 = `base64(hmac-sha1(密钥, 用户名))`），浏览器拿到的凭据到期自动作废。

### 1. coturn 侧（turnserver.conf）

```conf
use-auth-secret
static-auth-secret=换成足够长的随机串   # 与 .env 的 TURN_SERVER_SECRET 一致
# 其余监听/证书/Realm 配置不变
```

### 2. 本服务侧（.env）

```env
TURN_SERVER_ENABLED=true
TURN_SERVER_URL=turn:turn.example.com:3478
TURN_SERVER_SECRET=换成足够长的随机串    # 与 coturn 的 static-auth-secret 一致
TURN_CREDENTIAL_TTL_SEC=43200           # 凭据有效期，默认 12 小时
```

设置了 `TURN_SERVER_SECRET` 后，`TURN_SERVER_USERNAME` / `TURN_SERVER_CREDENTIAL` 会被忽略（仍可保留给内网静态模式随时切回）。凭据在有效期过半时自动重铸，重连的客户端在下次 `addPeer` 时拿到新凭据。

> 注意：凭据过期只阻止**新的** TURN 分配，已建立的分配不受影响，因此 12 小时的 TTL 覆盖绝大多数通话；跨天的长频道成员断线重连时会自动获得新凭据。
