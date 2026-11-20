/*
Socket 事件接线 —— 把信令协议的每个 socket.io 事件映射到
页面动作，外加持久化聊天历史的向上滚动分页
（游标 = 已有最旧行的 ts；服务器每次 join 都重放最新一页，
更老的页经 chatPage ack 逐页回拉）。

位于模块作用域（不在页面控制器内）：bindHistoryPaging()
在 socket 处理器接线之前的 boot() 里绑定滚动监听。
共享页面状态经 `s` 存取器对象到达，跨模块调用走晚绑定的
`x` 调用面（两者都归 channel.js 所有）；成员列表助手经
`mem`，恢复经 `rec`。
*/

export function createSocketEvents({
    s,
    x,
    rec,
    mem,
    members,
    avatars,
    peerVolumes,
    channelId,
    NICK_KEY,
    AVATAR_MAX_CHARS,
    DATA_URL_RE,
    validReply,
    screenLock,
    playSound,
    toast,
    t,
    $,
}) {
    // 服务器在每次 join（含重连）时都重放持久化聊天历史 ——
    // 只有页面加载后的第一块会被渲染
    let chatHistorySeen = false;
    // 该历史的向上滚动分页：游标 = 已有最旧行的 ts，
    // hasMore 镜像服务器的报告，loading 保护
    // 单个在途 chatPage 请求
    let historyCursor = null;
    let historyHasMore = false;
    let historyLoading = false;
    // 镜像 chat.js 的 nearBottom()：在触及顶部之前预取一页
    const CHAT_LOAD_THRESHOLD = 80;

    // 传输层断连（VPN 切换、网络闪断）通常几秒内重连 ——
    // 「已断开」提示压到确认真的断了再弹
    const DISCONNECT_TOAST_MS = 3000;
    let disconnectToastTimer = null;

    // join 应答确认：join 事件没有内建 ack，而服务器只在唯一
    // 一处一言不发地丢弃 join（鉴权失败冷却 —— 见 signaling.js
    // joinThrottled）。没有超时的话，被静默丢弃的 join 会让页面
    // 干等一个永不到来的 serverInfo，这正是恢复阶梯看不见的
    // 那条死路。serverInfo 清掉定时器；超时则（有上限地）重发，
    // 然后如实告知。
    const JOIN_ACK_MS = 10000;
    const JOIN_ACK_MAX_RETRIES = 3;
    let joinAckTimer = null;
    let joinAckRetries = 0;
    let joinThrottleUntil = 0; // epoch ms —— 服务器告知的冷却，join 重发要等它过去

    function clearJoinAck() {
        clearTimeout(joinAckTimer);
        joinAckTimer = null;
    }

    function armJoinAck() {
        clearJoinAck();
        joinAckTimer = setTimeout(onJoinAckTimeout, JOIN_ACK_MS);
    }

    function onJoinAckTimeout() {
        joinAckTimer = null;
        if (s.joined || !s.socket) return;
        if (!s.socket.connected) {
            armJoinAck(); // 离线：重连处理器会替我们重发 join
            return;
        }
        const waitLeft = joinThrottleUntil - Date.now();
        if (waitLeft > 0) {
            joinAckTimer = setTimeout(onJoinAckTimeout, waitLeft + 500); // 服务器告知的冷却说了算
            return;
        }
        if (joinAckRetries < JOIN_ACK_MAX_RETRIES) {
            joinAckRetries += 1;
            console.warn('[socket] join not acknowledged, re-sending', joinAckRetries);
            emitJoin();
            armJoinAck();
            return;
        }
        joinAckRetries = 0; // 之后的重连周期会拿到全新预算
        toast(t('channel.errors.joinTimeout'), 'warn');
        armJoinAck(); // 继续盯着 —— 下一个 serverInfo 会悄悄了结它
    }

    // TURN REST 凭证会过期（用户名就是 unix 过期时间戳），
    // 而这份列表在 addPeer 时就烤进了每个 RTCPeerConnection ——
    // 比凭证活得更久的会话，会把每次恢复用的 iceRestart 发给
    // 一个不再认它的 coturn。在最早的过期时间落进载荷之前不久
    // 重新武装一次拉取；新集合经 mesh.updateIceServers 进
    // setConfiguration。
    const ICE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
    // 对 memoized 服务器的廉价 ack —— 尽快重试，而不是拿着
    // 可能正在过期的凭证干等一个长窗口
    const ICE_REFRESH_RETRY_MS = 60 * 1000;
    // 协商中 setConfiguration 被拒（罕见）：稍后重应用同一份列表，
    // 而不是等下一轮拉取周期
    const ICE_APPLY_RETRY_MS = 30 * 1000;
    let iceRefreshTimer = null;
    let iceApplyRetryTimer = null;

    /** 依据最新的 addPeer 载荷（重）排下一次凭证拉取。 */
    function scheduleIceRefresh(iceServers) {
        // 只有 REST 模式的条目才带数字过期用户名；静态账号与
        // 纯 STUN 永不过期 —— 无需排程
        let expiresAtSec = null;
        for (const server of iceServers || []) {
            const expiry = Number(server?.username);
            if (Number.isFinite(expiry) && expiry > 0 && (expiresAtSec === null || expiry < expiresAtSec)) {
                expiresAtSec = expiry;
            }
        }
        clearTimeout(iceRefreshTimer);
        iceRefreshTimer = null;
        if (expiresAtSec === null) return;
        // 不设人为下限：载荷已进入余量窗口（短命凭证）时必须
        // 立即拉取 —— 设下限可能让刷新排在它本要赶超的
        // 过期时间之后
        const delay = Math.max(0, ICE_REFRESH_MARGIN_MS + expiresAtSec * 1000 - Date.now());
        iceRefreshTimer = setTimeout(refreshIceServers, delay);
    }

    function refreshIceServers() {
        iceRefreshTimer = null;
        const socket = s.socket;
        // 不在活动会话中：下一个 addPeer（join / 新对端）会重新排程
        if (!socket?.connected || !s.joined) return;
        socket.timeout(8000).emit('refreshIceServers', null, (err, iceServers) => {
            if (err || !Array.isArray(iceServers) || !iceServers.length) {
                iceRefreshTimer = setTimeout(refreshIceServers, ICE_REFRESH_RETRY_MS);
                return;
            }
            applyIceServers(iceServers);
            scheduleIceRefresh(iceServers);
        });
    }

    /**
     * 把新列表推进每条存活连接；仍有 PC 拒绝（协商中的边缘情况）
     * 时每 30s 链式重试，直到清零或下一份列表到来——一次性重试
     * 在短 TTL 凭据部署里余量太薄。
     */
    function applyIceServers(iceServers) {
        const refused = s.mesh?.updateIceServers(iceServers) || 0;
        if (refused > 0) {
            clearTimeout(iceApplyRetryTimer);
            iceApplyRetryTimer = setTimeout(() => applyIceServers(iceServers), ICE_APPLY_RETRY_MS);
        }
    }

    /** 服务器历史行 -> 可渲染行（join 与分页共用）。 */
    function parseHistoryRows(messages) {
        const rows = [];
        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            const name = String(msg.name || '?').slice(0, 24);
            let text = typeof msg.text === 'string' ? msg.text : '';
            const imgs = Array.isArray(msg.imgs) ? msg.imgs : []; // prependHistory 会重新校验每个 URL
            // 旧版行（≤ voice.21）只留了图片数量 —— 以占位符显示
            const legacyCount = Number.isInteger(msg.imgs) && msg.imgs > 0 ? msg.imgs : 0;
            if (legacyCount) text = [text, `[${t('chat.image')}×${legacyCount}]`].filter(Boolean).join(' ');
            if (!text && !imgs.length && msg.deleted !== true) continue;
            const ts = typeof msg.ts === 'number' && msg.ts > 0 ? msg.ts : 0;
            const reply = validReply(msg.reply);
            const deleted = msg.deleted === true;
            const reactions =
                msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions)
                    ? msg.reactions
                    : null;
            rows.push({
                name,
                text,
                imgs: deleted ? [] : imgs,
                reply,
                deleted,
                edited: msg.edited === true,
                reactions,
                self: name === s.selfName,
                time: ts ? new Date(ts) : new Date(),
            });
        }
        return rows;
    }

    function bindHistoryPaging(box) {
        box.addEventListener('scroll', maybeLoadOlder, { passive: true });
    }

    /** 列表滚动到接近顶部时触发一次翻页拉取。 */
    function maybeLoadOlder() {
        if (!s.socket || !historyHasMore || historyLoading) return;
        const box = $('#chatMessages');
        if (!box || box.scrollTop > CHAT_LOAD_THRESHOLD) return;
        loadOlderPage();
    }

    function loadOlderPage() {
        if (historyLoading || !historyHasMore) return;
        historyLoading = true;
        s.chat.setHistoryFooter('loading');
        // ack 让请求与响应配对；应答永不到来时超时会解开
        // 标志位，之后的滚动还能重试
        s.socket.timeout(8000).emit('chatPage', { room_id: channelId, before: historyCursor ?? 0 }, (err, res) => {
            historyLoading = false;
            s.chat.setHistoryFooter(null);
            if (err) {
                // 超时/服务器拒绝——页脚已清、滚动可重试，但别完全无声
                console.warn('[chat] history page fetch failed', err);
                return;
            }
            const messages = Array.isArray(res?.messages) ? res.messages : [];
            historyHasMore = res?.hasMore === true;
            if (messages.length) {
                const first = messages[0]; // 又是本页最旧的一条
                if (first && typeof first.ts === 'number' && first.ts > 0) historyCursor = first.ts;
                s.chat.prependHistory(parseHistoryRows(messages), { imageAlt: t('chat.image') });
            }
            if (historyHasMore)
                maybeLoadOlder(); // 视口可能仍未填满
            else s.chat.setHistoryFooter('end');
        });
    }

    function emitJoin() {
        s.socket.emit('join', {
            channel: channelId,
            peer_uuid: s.selfUuid,
            peer_name: s.selfName,
            peer_token: s.hostToken || undefined,
            channel_password: s.channelPassword || undefined,
            peer_audio: x.onAir(),
        });
        armJoinAck();
    }

    function peerIdSafe(id) {
        return typeof id === 'string' ? id : '';
    }

    function registerSocketHandlers() {
        const socket = s.socket;

        socket.on('connect', () => {
            // 回到了闪断窗口内 —— 「已断开」提示从未弹出
            clearTimeout(disconnectToastTimer);
            disconnectToastTimer = null;
            emitJoin();
        });

        socket.on('serverInfo', (cfg) => {
            // 一次成功的（重）join 会了结任何未决的自愈重连
            // 与任何未决的 join-ack 超时
            rec.markSessionRestored();
            clearJoinAck();
            joinAckRetries = 0;
            if (!s.joined) {
                s.joined = true;
                rec.startRecoveryScan();
                rec.startPathMonitor();
                screenLock.sync();
                s.isPresenter = !!cfg.is_presenter;
                s.joinLockOn = !!cfg.join_locked;
                $('#joinOverlay').classList.add('hidden');
                x.updateHeaderActions();
                mem.syncMembers(cfg.peers || {});
                s.chat.add({ text: t('chat.joined', { name: s.selfName }), system: true, self: true });
                x.syncPttHoldButton();
                x.applyDeafenState(); // 把（会话本地的）状态反映到新成员卡片上
                // 密码通过 —— 留着供下次自动 join 使用
                if (s.channelPassword) x.saveChannelPw(s.channelPassword);
                // 告诉房间里的所有人我们带的是什么头像（peers 列表
                // 只从房间流向加入者，这是加入者 -> 房间的方向）
                if (s.selfAvatar) socket.emit('peerAvatar', { room_id: channelId, avatar: s.selfAvatar });
            } else {
                s.isPresenter = !!cfg.is_presenter;
                s.joinLockOn = !!cfg.join_locked;
                x.updateHeaderActions();
            }
            mem.updateOnlineCount();
        });

        socket.on('chatAck', ({ ts } = {}) => {
            // 服务器为乐观渲染的那一行指派的时间戳 ——
            // 没有它，编辑/撤回/回应将查到一个别人都没有的 ts
            s.chat.bindServerTs(ts);
        });

        socket.on('chatHistory', (cfg) => {
            // 重连重放被忽略：活动 DOM 已持有近期上下文，
            // 再渲染一次会让每行重复
            if (chatHistorySeen) return;
            chatHistorySeen = true;
            // 持久化历史的最新一页；更老的页在用户滚到顶部时
            // 按需回拉
            historyHasMore = cfg?.hasMore === true;
            const messages = Array.isArray(cfg?.messages) ? cfg.messages : [];
            const first = messages[0]; // 服务器最旧的在前
            if (first && typeof first.ts === 'number' && first.ts > 0) historyCursor = first.ts;
            const rows = parseHistoryRows(messages);
            if (!rows.length) return;
            s.chat.addHistory(rows, { dividerText: t('chat.historyDivider'), imageAlt: t('chat.image') });
            maybeLoadOlder(); // 视口还没填满就继续拉
        });

        socket.on('addPeer', (cfg) => {
            const known = s.mesh.entries.has(cfg.peer_id);
            scheduleIceRefresh(cfg.iceServers); // 最新的凭证过期时间随每个 addPeer 送达
            s.mesh.addPeer(cfg.peer_id, cfg.should_create_offer, cfg.iceServers || []);
            mem.syncMembers(cfg.peers || {});
            // should_create_offer=false 意味着：我们是老成员，别人
            // 刚刚加入 —— 由我们播报（加入者会按每个既有成员各收
            // 一个事件，绝不能再播报所有人）。rejoin=true 是从网络
            // 闪断中回来的原地恢复会话：它的卡片从未离开，
            // 不播报、不响声。
            if (s.joined && cfg.should_create_offer === false && !cfg.rejoin) {
                const name = members.get(cfg.peer_id)?.peer_name || '';
                if (name) s.chat.add({ text: t('chat.joined', { name }), system: true });
                playSound('peerJoin');
            }
            // 带既有（可能已损坏）链路的恢复会话：mesh 条目被复用，
            // 没有 offer 发出 —— 现在就把恢复阶梯架上去，
            // 而不是等下一轮 10s 扫描
            if (known && cfg.should_create_offer === true) {
                const state = s.mesh.entries.get(cfg.peer_id)?.pc.connectionState;
                if (state && state !== 'connected' && state !== 'closed') rec.notePeerState(cfg.peer_id, state);
            }
            // rejoin=true 且链路已知（两侧对称）：对端刚从断线中回来，
            // 此刻信令必能投递——曾被它 ghost 窗口吞掉 answer 的
            // offer 立刻解卡重发（免 OFFER_STUCK_MS 盲等）。老成员
            // 一侧与 resume 一侧都可能卡着这样的 offer，两边都体检
            if (known && cfg.rejoin === true) rec.retryStuckOffer(cfg.peer_id);
            mem.updateOnlineCount();
        });

        socket.on('removePeer', ({ peer_id }) => {
            const name = members.get(peer_id)?.peer_name || '';
            mem.dropPeer(peerIdSafe(peer_id));
            if (s.joined && name) {
                s.chat.add({ text: t('chat.left', { name }), system: true });
                playSound('peerLeave');
            }
            mem.updateOnlineCount();
        });

        socket.on('iceCandidate', (cfg) => s.mesh.handleIceCandidate(cfg));
        socket.on('sessionDescription', (cfg) => s.mesh.handleSessionDescription(cfg));

        // 我们中转出去的 SDP 没有投递落脚处（服务器对 ghost 吞信令
        // 的回执，见 signaling.js）——立刻探测对端：'gone' 当场拆卡，
        // 'ghost' 记下 resume 宽限好让恢复阶梯的升级动作让路，
        // 都不必等到阶梯的下一轮
        socket.on('relayUndelivered', (cfg) => {
            if (cfg?.peer_id) rec.onRelayUndelivered(cfg.peer_id);
        });

        // 消息生命周期 —— 服务器把持久化结果广播给所有人
        // （含发送者），DOM 跟随存储走
        socket.on('chatEdit', (cfg) => {
            if (Number.isFinite(cfg?.ts))
                s.chat.editMessage({
                    name: String(cfg.name || '').slice(0, 24),
                    ts: cfg.ts,
                    text: String(cfg.text || ''),
                });
        });
        socket.on('chatDelete', (cfg) => {
            if (Number.isFinite(cfg?.ts))
                s.chat.deleteMessage({ name: String(cfg.name || '').slice(0, 24), ts: cfg.ts });
        });
        socket.on('chatReact', (cfg) => {
            if (Number.isFinite(cfg?.ts))
                s.chat.reactMessage({
                    name: String(cfg.name || '').slice(0, 24),
                    ts: cfg.ts,
                    reactions: cfg.reactions,
                });
        });

        socket.on('peerStatus', ({ peer_id, element, status }) => {
            if (element === 'audio') {
                const member = members.get(peer_id);
                if (!member) return;
                member.peer_audio_status = status === true;
                mem.updateMicIconNode(peer_id, status === true);
                return;
            }
            if (element === 'deafen') {
                const member = members.get(peer_id);
                if (!member) return;
                member.peer_deafen = status === true;
                const node = $(`#memberList .member[data-id="${peer_id}"] .member-deafen`);
                if (node) node.classList.toggle('on', status === true);
            }
            if (element === 'share') {
                const member = members.get(peer_id);
                if (!member) return;
                member.peer_share = status === true;
                const node = $(`#memberList .member[data-id="${peer_id}"] .member-share`);
                if (node) node.classList.toggle('on', status === true);
            }
        });

        socket.on('peerName', ({ peer_id, peer_name: rawName, peer_name_old }) => {
            // 主持人提供的：按 join/改名输入框一样截断，防止恶意
            // 主持人把超长字符串推进状态或 localStorage
            const peer_name = String(rawName || '').slice(0, 24);
            if (!peer_name) return;
            const member = members.get(peer_id);
            const old = member?.peer_name;
            if (member && old && old !== peer_name) {
                // 按用户音量记忆以显示名为键 —— 跟随改名
                if (peerVolumes[old] !== undefined && peerVolumes[old] !== 1) {
                    x.savePeerVolume(peer_name, peerVolumes[old]);
                }
                x.savePeerVolume(old, 1); // 丢掉过期键
                // 头像查找也以名字为键 —— 一并迁移
                const avatar = avatars.get(old);
                if (avatar) {
                    avatars.set(peer_name, avatar);
                    avatars.delete(old);
                }
                s.chat.renamePeer(old, peer_name);
                member.peer_name = peer_name;
                if (peerVolumes[peer_name] !== undefined) {
                    member.volume = peerVolumes[peer_name];
                    // 滑杆随重渲染换到了新值——音频图的增益也要跟上，
                    // 否则 UI 与实际播放会分叉，直到下一次全局 reapply
                    x.reapplyPeerVolume(peer_id);
                }
            } else if (member) {
                member.peer_name = peer_name;
            }
            if (peer_id === s.selfUuid) {
                // 主持人改名了我 —— 接受并持久化供下次访问
                s.selfName = peer_name;
                localStorage.setItem(NICK_KEY, peer_name);
                if (s.selfAvatar) avatars.set(s.selfName, s.selfAvatar);
                s.chat.setAvatar(s.selfName, s.selfAvatar);
                $('#nickInput').value = peer_name;
                toast(t('channel.renamedYou', { name: peer_name }), 'ok');
            } else if (s.joined && member && (peer_name_old || old)) {
                s.chat.add({
                    text: t('chat.renamed', { old: peer_name_old || old, name: peer_name }),
                    system: true,
                });
            }
            mem.renderMembers();
        });

        socket.on('peerAvatar', ({ peer_id, peer_name, avatar }) => {
            const url =
                typeof avatar === 'string' && avatar.length <= AVATAR_MAX_CHARS && DATA_URL_RE.test(avatar)
                    ? avatar
                    : '';
            const member = members.get(peerIdSafe(peer_id));
            if (member) member.avatar = url || undefined;
            if (peer_name) {
                if (url) {
                    avatars.set(peer_name, url);
                    mem.capAvatars();
                } else avatars.delete(peer_name);
                s.chat.setAvatar(peer_name, url);
            }
            mem.renderMembers();
        });

        socket.on('peerAction', ({ peer_id, peer_action }) => {
            if (peer_id === s.selfUuid && peer_action === 'muteAudio') {
                x.setMic(false);
                toast(t('channel.mutedByHost'), 'warn');
            }
        });

        socket.on('roomAction', ({ peer_name, action }) => {
            if (action === 'joinLockOn') {
                s.joinLockOn = true;
                s.chat.add({ text: t('channel.joinLockOn', { name: peer_name }), system: true });
            } else if (action === 'joinLockOff') {
                s.joinLockOn = false;
                s.chat.add({ text: t('channel.joinLockOff', { name: peer_name }), system: true });
            }
            x.updateHeaderActions();
        });

        socket.on('kickOut', (cfg) => {
            x.teardown();
            // 被主持人移出 vs. 管理员从脚下删掉房间
            x.showJoinFatal(cfg?.reason === 'channelDeleted' ? t('channel.channelDeleted') : t('channel.kicked'));
        });

        socket.on('channelNotFound', () => x.showJoinFatal(t('channel.errors.channelNotFound')));
        socket.on('roomIsBusy', (cfg) =>
            x.showJoinError(t('channel.errors.roomIsBusy', { n: cfg?.maxParticipants || 0 }))
        );
        socket.on('roomIsJoinLocked', () => x.showJoinError(t('channel.errors.roomIsJoinLocked')));
        socket.on('roomIsLocked', () => x.showJoinError(t('channel.errors.roomIsLocked')));
        socket.on('tempRoomLimitReached', (cfg) =>
            x.showJoinError(
                cfg?.reason === 'rate-limit'
                    ? t('channel.errors.tempRateLimit')
                    : t('channel.errors.tempIpLimit', { n: cfg?.max || 0 })
            )
        );
        socket.on('channelLimitReached', (cfg) =>
            x.showJoinError(t('channel.errors.channelLimit', { n: cfg?.max || 0 }))
        );
        socket.on('channelPasswordRequired', () => {
            // 频道密码错误或缺失 —— 丢掉过期的记忆值，
            // 覆盖层保持展开直到输入正确的密码
            x.clearChannelPw();
            s.channelPassword = '';
            x.showJoinError(t('channel.errors.passwordRequired'));
            $('#joinPasswordField').classList.remove('hidden');
            $('#channelPwInput').value = '';
            $('#channelPwInput').focus();
        });
        socket.on('unauthorized', () => {
            if (!s.hostToken) return x.showJoinError(t('channel.errors.unauthorized'));
            // 持久化的令牌不再被接受（过期或主持人已从频道配置
            // 移除）—— 丢弃它，以访客身份继续
            x.clearHostToken();
            s.hostToken = '';
            $('#hostReadyHint').classList.add('hidden');
            toast(t('channel.hostTokenExpired'), 'warn');
            if (s.joined)
                emitJoin(); // 已建立会话的重连：不带令牌重进
            else {
                s.socket.disconnect();
                x.join({ textOnly: false });
            }
        });
        socket.on('joinError', () => {
            // join 中途的服务器故障（处理器会记录细节）——
            // 会话状态已在服务器侧回滚，这里干净地重来
            clearJoinAck();
            x.showJoinError(t('channel.errors.joinFailed'));
            x.setOverlayBusy(false);
        });
        socket.on('joinThrottled', ({ retryAfter } = {}) => {
            // 鉴权失败冷却丢弃了这次 join（共享 NAT 也会让无辜用户
            // 触发）—— 这次有告知而非静默，所以把重发循环
            // 卡到精确的秒数，并说明 join 为何卡住
            const seconds = Math.max(1, Math.min(600, Number(retryAfter) || 60));
            joinThrottleUntil = Date.now() + seconds * 1000;
            clearJoinAck();
            joinAckTimer = setTimeout(onJoinAckTimeout, seconds * 1000 + 500);
            toast(t('channel.errors.joinThrottled', { n: seconds }), 'warn');
        });

        socket.on('disconnect', (reason) => {
            if (!s.joined) return;
            // mesh 与成员列表在断连中「存活」：服务器把我们的会话
            // 挂起为幽灵，这个 socket 以同一 peer_uuid 重新 join，
            // 既有的对端连接原地恢复 —— 它们经 ICE-restart 恢复阶梯
            // 治愈，而不是全量重协商。
            // 主动退出（离开、被踢、自己的 B1 重建、join 错误）
            // 会在断开前自己拆干净状态。
            if (reason === 'io client disconnect' || rec.selfReconnecting) return;
            // 短暂的传输闪断（VPN/加速器切换）通常几秒内重连 ——
            // 确认真断了再喊「已断开」
            clearTimeout(disconnectToastTimer);
            disconnectToastTimer = setTimeout(() => {
                disconnectToastTimer = null;
                if (!s.socket?.connected && s.joined) toast(t('channel.errors.disconnected'), 'warn');
            }, DISCONNECT_TOAST_MS);
        });
    }

    return {
        registerSocketHandlers,
        bindHistoryPaging,
        clearDisconnectToast: () => {
            clearTimeout(disconnectToastTimer);
            disconnectToastTimer = null;
        },
        stopIceRefresh: () => {
            clearTimeout(iceRefreshTimer);
            iceRefreshTimer = null;
            clearTimeout(iceApplyRetryTimer);
            iceApplyRetryTimer = null;
        },
        stopJoinAck: clearJoinAck,
    };
}
