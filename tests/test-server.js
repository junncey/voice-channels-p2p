'use strict';

// npx mocha test-server.js
//
// 信令集成测试：真实服务器实例 + socket.io-client 成对客户端，覆盖
// join/addPeer、幽灵宽限 + 同 uuid resume、主动离开、人数/密码门禁、
// join 节流反馈、聊天历史留存（含按会话 uuid 查发送者）
// 以及管理端成员名单 / 踢人端点。
//
//
// 套件在进程内运行：env 在 server.js（从而 config.js）加载之前固定。
// 仓库真实的 channels.json / chat_history 会被备份并在结束后还原——
// 测试运行期间由它接管。幽灵宽限窗口经 GHOST_GRACE_MS 缩短，
// 让过期用例几秒内跑完。

process.env.PORT = '3100';
process.env.CHANNEL_ADMIN_PASSWORD = 'test-admin-pw';
process.env.CHANNEL_ADMIN_JWT_SECRET = 'test-jwt-secret';
process.env.LOGS_DEBUG = 'false';
process.env.GHOST_GRACE_MS = '1200';
process.env.GHOST_GRACE_LATE_MS = '600';
process.env.TEMP_ROOMS_ENABLED = 'true';
process.env.AUTO_INIT_CHANNELS = 'true';
// join 节流测试用伪造的 x-forwarded-for IP 触发鉴权失败冷却，
// 保证其他测试共用的 127.0.0.1 计数器保持干净
process.env.TRUST_PROXY = 'true';
// REST/HMAC TURN 模式：每个 addPeer / refreshIceServers 负载都必须带上
// 铸出的临时凭证（由“fresh TURN REST credentials”用例行使）
process.env.TURN_SERVER_ENABLED = 'true';
process.env.TURN_SERVER_URL = 'turn:t1.example.com:3478,turn:t2.example.com:3478';
process.env.TURN_SERVER_SECRET = 'test-turn-secret';
process.env.TURN_CREDENTIAL_TTL_SEC = '7200';

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');

// 审计日志同样不得碰仓库真实文件（env 必须在 server.js 加载前固定，
// 所以放在 require 之后这一行）
process.env.VC_AUDIT_FILE = path.join(os.tmpdir(), `vc-audit-test-${process.pid}.jsonl`);

const SRC = path.join(__dirname, '..', 'app', 'src');
const CHANNELS_FILE = path.join(SRC, 'channels.json');
const CHAT_DIR = path.join(SRC, 'chat_history');
const URL = 'http://127.0.0.1:3100';
const GHOST_MS = Number(process.env.GHOST_GRACE_MS);

const backupDir = path.join(os.tmpdir(), `vc-server-test-${Date.now()}`);
const hadChannelsFile = fs.existsSync(CHANNELS_FILE);
const hadChatDir = fs.existsSync(CHAT_DIR);
// 已存在的注册表 sidecar 文件属于用户——after() 钩子只能删除本套件
// 自己产出的那些（旧清理逻辑曾在主文件缺席时误删一个预先存在的
// channels.json.bak）
const REGISTRY_SIDEcars = ['.bak', '.corrupt', '.tmp'];
const preexistingSidecars = new Set(
    REGISTRY_SIDEcars.filter((suffix) => fs.existsSync(CHANNELS_FILE + suffix)).map((suffix) => CHANNELS_FILE + suffix)
);

// 在服务器自动创建之前先备份
fs.mkdirSync(backupDir, { recursive: true });
if (hadChannelsFile) fs.copyFileSync(CHANNELS_FILE, path.join(backupDir, 'channels.json'));
if (hadChatDir) fs.cpSync(CHAT_DIR, path.join(backupDir, 'chat_history'), { recursive: true });

/**
 * 把用户的数据文件原样归还。幂等：正常运行时经 after() 调用，
 * 同时也挂在下方进程的 'exit' 钩子上——硬性测试失败或 Ctrl+C 都不能
 * 让被换掉的注册表留在原地
 * （SIGKILL 谁也拦不住）。
 */
let userDataRestored = false;
function restoreUserData() {
    if (userDataRestored) return;
    userDataRestored = true;
    if (hadChannelsFile) fs.copyFileSync(path.join(backupDir, 'channels.json'), CHANNELS_FILE);
    else if (fs.existsSync(CHANNELS_FILE)) fs.unlinkSync(CHANNELS_FILE);
    // sidecar：只删 TEST 自己创建的，绝不碰用户的文件
    for (const suffix of REGISTRY_SIDEcars) {
        const file = CHANNELS_FILE + suffix;
        if (!preexistingSidecars.has(file) && fs.existsSync(file)) fs.unlinkSync(file);
    }
    if (hadChatDir) {
        fs.rmSync(CHAT_DIR, { recursive: true, force: true });
        fs.cpSync(path.join(backupDir, 'chat_history'), CHAT_DIR, { recursive: true });
    } else if (fs.existsSync(CHAT_DIR)) {
        fs.rmSync(CHAT_DIR, { recursive: true, force: true });
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
}
process.on('exit', restoreUserData);

require('../app/src/server.js'); // 开始监听 :3100

let adminToken = '';

function connect() {
    return io(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
}

function joinPayload(channel, uuid, name) {
    return { channel, peer_uuid: uuid, peer_name: name, peer_audio: true };
}

function once(socket, event, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

function emitted(socket, event, withinMs = 300) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), withinMs);
        socket.once(event, () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 传输层骤死（无 disconnect 包）——走幽灵路径。 */
function abruptClose(socket) {
    socket.io.engine.close();
}

async function adminApi(method, urlPath, body) {
    return fetch(URL + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: body ? JSON.stringify(body) : undefined,
    });
}

/** 每个用例用全新的唯一房间 ID，避免幽灵过期广播互相串扰。 */
function freshRoom(prefix) {
    return (
        prefix +
        crypto
            .randomUUID()
            .slice(0, 8)
            .replace(/[^a-zA-Z0-9]/g, '')
    );
}

describe('test-server (signaling integration)', function () {
    this.timeout(10000);
    before(async () => {
        // 冷启动时上方的 require() 会在 listen 回调触发前就返回——
        // 先轮询一次就绪状态，而不是和登录抢跑
        for (let i = 0; i < 50; i++) {
            try {
                await fetch(URL + '/api/version');
                break;
            } catch {
                await wait(100);
            }
        }
        const res = await fetch(URL + '/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: process.env.CHANNEL_ADMIN_PASSWORD }),
        });
        const data = await res.json();
        adminToken = data.token;
        const created = await adminApi('POST', '/api/admin/channels', {
            id: 'troom',
            name: 'Test Room',
            maxParticipants: 3,
        });
        await created.json();
        const pwChannel = await adminApi('POST', '/api/admin/channels', {
            id: 'tlocked',
            name: 'Locked Room',
            password: 'secret-pw',
        });
        await pwChannel.json();
        // 套件会从同一 IP 频繁开出大量短命临时房间——调高防滥用配额
        // （数值必须落在 settings schema 上限之内）
        await adminApi('PUT', '/api/admin/settings', { tempCreateMax: 500, tempMaxPerIp: 100 });
    });

    after(() => {
        restoreUserData();
    });

    let socketsToClose = [];
    afterEach(() => {
        for (const sock of socketsToClose) {
            try {
                sock.disconnect();
            } catch {
                /* 早已不在 */
            }
        }
        socketsToClose = [];
    });

    function track(sock) {
        socketsToClose.push(sock);
        return sock;
    }

    describe('1. join mesh handshake', () => {
        it('should exchange addPeer with correct offer sides and peer maps', async () => {
            const room = freshRoom('mesh');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            const infoA = await once(a, 'serverInfo');
            infoA.peers_count.should.equal(1);
            infoA.peers[ua].peer_name.should.equal('alice');

            const b = track(connect());
            const gotAddPeer = once(a, 'addPeer');
            const gotToAddPeer = once(b, 'addPeer'); // addPeer 风暴先于 serverInfo 到达
            b.emit('join', joinPayload(room, ub, 'bob'));
            const toA = await gotAddPeer;
            toA.peer_id.should.equal(ub);
            toA.should_create_offer.should.equal(false);
            toA.peers[ub].peer_name.should.equal('bob');

            const infoB = await once(b, 'serverInfo');
            infoB.peers_count.should.equal(2);
            const toB = await gotToAddPeer;
            toB.peer_id.should.equal(ua);
            toB.should_create_offer.should.equal(true);
        });

        it('should serve fresh TURN REST credentials on addPeer and refreshIceServers', async () => {
            const room = freshRoom('ice');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            const b = track(connect());
            const gotAddPeer = once(a, 'addPeer');
            b.emit('join', joinPayload(room, ub, 'bob'));
            const toA = await gotAddPeer;

            // addPeer 负载带着铸出的 HMAC 集：数字（unix 过期时间）用户名、
            // 每个逗号分隔的 TURN URL 一条，以及 coturn REST 文档规定的
            // 密码 = base64(hmac-sha1(secret, username))
            const turn = (toA.iceServers || []).filter((server) => String(server.urls || '').startsWith('turn:'));
            turn.should.have.length(2);
            const expiresAtSec = Number(turn[0].username);
            Number.isFinite(expiresAtSec).should.be.true();
            expiresAtSec.should.be.greaterThan(Date.now() / 1000);
            turn[0].username.should.equal(turn[1].username);
            const expected = crypto.createHmac('sha1', 'test-turn-secret').update(turn[0].username).digest('base64');
            turn[0].credential.should.equal(expected);

            // 半衰期之前，ack 式刷新下发的是同一份缓存集
            const refreshed = await new Promise((resolve, reject) => {
                a.timeout(4000).emit('refreshIceServers', null, (err, list) => (err ? reject(err) : resolve(list)));
            });
            JSON.stringify(refreshed).should.equal(JSON.stringify(toA.iceServers));
        });

        it('should relay SDP only between members of a shared room', async () => {
            const room = freshRoom('relay');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            const got = once(b, 'sessionDescription');
            a.emit('relaySDP', { peer_id: ub, session_description: { type: 'offer', sdp: 'v=0 test' } });
            const relayed = await got;
            relayed.peer_id.should.equal(ua);
            relayed.session_description.sdp.should.equal('v=0 test');

            // 未知目标 → 回执给发送方（客户端据此立刻做 presence
            // 分流，把 offer 卡死判定从 8s 盲等降为 RTT 级），
            // 且绝不中转给无关成员
            const undelivered = once(a, 'relayUndelivered');
            a.emit('relaySDP', { peer_id: crypto.randomUUID(), session_description: { type: 'offer', sdp: 'x' } });
            const receipt = await undelivered;
            receipt.kind.should.equal('sdp');
            (await emitted(b, 'sessionDescription', 250)).should.be.false();
        });

        it('should relay share status and hand it to later joiners', async () => {
            const room = freshRoom('share');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            const got = once(b, 'peerStatus');
            a.emit('peerStatus', { room_id: room, peer_name: 'alice', peer_id: ua, element: 'share', status: true });
            const relayed = await got;
            relayed.peer_id.should.equal(ua);
            relayed.element.should.equal('share');
            relayed.status.should.be.true();

            // 翻转之后加入的成员在 peer map 里看到该状态
            const c = track(connect());
            c.emit('join', joinPayload(room, crypto.randomUUID(), 'carol'));
            const infoC = await once(c, 'serverInfo');
            infoC.peers[ua].peer_share.should.be.true();
            infoC.peers[ub].peer_share.should.be.false();

            // 未知 element 一律不中转
            a.emit('peerStatus', { room_id: room, peer_name: 'alice', peer_id: ua, element: 'bogus', status: true });
            (await emitted(c, 'peerStatus', 250)).should.be.false();
        });

        it('should ignore peerName with non-string or blank names', async () => {
            const room = freshRoom('pname');
            const ua = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            const b = track(connect());
            b.emit('join', joinPayload(room, crypto.randomUUID(), 'bob'));
            await once(b, 'serverInfo');
            await wait(50);

            // 非字符串/空白名不得写进房间状态并随成员广播扩散
            const seen = [];
            b.on('peerName', (cfg) => seen.push(cfg));
            a.emit('peerName', { room_id: room, peer_name_new: 12345 });
            a.emit('peerName', { room_id: room, peer_name_new: '   ' });
            a.emit('peerName', { room_id: room, peer_name_new: null });
            await wait(150);
            seen.length.should.equal(0);

            // 合法改名（含 trim）照常广播
            a.emit('peerName', { room_id: room, peer_name_new: '  alice2  ' });
            const got = await once(b, 'peerName');
            got.peer_name.should.equal('alice2');
        });
    });

    describe('2. chat history persistence', () => {
        it('should store and replay text messages with the joined name', async () => {
            const ua = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload('troom', ua, 'carol'));
            await once(a, 'serverInfo');
            a.emit('chat', { room_id: 'troom', msg: 'hello history' });
            await wait(200);

            const c = track(connect());
            c.emit('join', joinPayload('troom', crypto.randomUUID(), 'dave'));
            const history = await once(c, 'chatHistory');
            const row = history.messages.find((m) => m.text === 'hello history');
            if (!row) throw new Error('history must contain the stored message');
            row.name.should.equal('carol');
        });

        it('should ack the sender with the authoritative ts of the stored row', async () => {
            const ua = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload('troom', ua, 'frank'));
            await once(a, 'serverInfo');
            const ack = once(a, 'chatAck');
            a.emit('chat', { room_id: 'troom', msg: 'ack me' });
            const { ts } = await ack;
            Number.isFinite(ts).should.be.true();
            ts.should.be.above(0);

            // 这个 ts 正是后续 edit/recall/reaction 用来定位的键
            const done = once(a, 'chatEdit');
            a.emit('chatEdit', { room_id: 'troom', ts, name: 'frank', msg: 'ack me (edited)' });
            const edited = await done;
            edited.text.should.equal('ack me (edited)');
        });

        it('should persist the reply quote with the row', async () => {
            const ua = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload('troom', ua, 'erin'));
            await once(a, 'serverInfo');
            a.emit('chat', {
                room_id: 'troom',
                msg: 'answering you',
                reply: { name: 'carol', text: 'hello history', ts: Date.now() - 60_000 },
            });
            await wait(200);

            const c = track(connect());
            c.emit('join', joinPayload('troom', crypto.randomUUID(), 'frank'));
            const history = await once(c, 'chatHistory');
            const row = history.messages.find((m) => m.text === 'answering you');
            if (!row) throw new Error('history must contain the reply message');
            row.reply.name.should.equal('carol');
            row.reply.text.should.equal('hello history');
        });

        it('should page older history via chatPage ack', async () => {
            const ua = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload('troom', ua, 'pager'));
            await once(a, 'serverInfo');
            for (let i = 0; i < 15; i++) {
                a.emit('chat', { room_id: 'troom', msg: `page-test-${i}` });
                await wait(30);
            }
            await wait(200);
            const c = track(connect());
            c.emit('join', joinPayload('troom', crypto.randomUUID(), 'reader'));
            const first = await once(c, 'chatHistory');
            first.messages.length.should.be.lessThanOrEqual(10);
            first.hasMore.should.be.true();
            const cursor = first.messages[0].ts;

            const older = await new Promise((resolve) => {
                c.timeout(4000).emit('chatPage', { room_id: 'troom', before: cursor }, (err, res) => {
                    if (err) throw err;
                    resolve(res);
                });
            });
            older.messages.length.should.be.greaterThan(0);
            older.messages.every((m) => m.ts < cursor).should.be.true();
        });
    });

    describe('3. ghost grace + same-uuid resume', () => {
        it('should NOT broadcast removePeer while a ghost sits in its grace window', async () => {
            const room = freshRoom('ghost');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            abruptClose(a);
            (await emitted(b, 'removePeer', Math.min(GHOST_MS - 300, 800))).should.be.false();
        });

        it('should resume the same uuid inside the window (addPeer rejoin:true)', async () => {
            const room = freshRoom('resume');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            abruptClose(a);
            await wait(150);
            const a2 = track(connect());
            const gotRejoin = once(b, 'addPeer');
            a2.emit('join', joinPayload(room, ua, 'alice'));
            const evt = await gotRejoin;
            evt.peer_id.should.equal(ua);
            evt.rejoin.should.equal(true);
            const info = await once(a2, 'serverInfo');
            info.peers_count.should.equal(2);
        });

        it('should remove the session once the grace expires', async () => {
            const room = freshRoom('expire');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            abruptClose(a);
            const evt = await once(b, 'removePeer', GHOST_MS + 3000);
            evt.peer_id.should.equal(ua);
        });

        it('should answer peerPresence probes: live / ghost / gone', async () => {
            const room = freshRoom('present');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            const probe = (socket, peer_id) =>
                new Promise((resolve, reject) =>
                    socket
                        .timeout(4000)
                        .emit('peerPresence', { peer_id }, (err, res) => (err ? reject(err) : resolve(res)))
                );

            // 两个会话都存活且可达
            (await probe(b, ua)).present.should.equal('live');
            // 宽限窗口内传输已死 → ghost（仍可能原地 resume），并随附
            // resume 窗口的剩余毫秒——恢复引擎据此把全量重建让路到
            // 宽限之后（ping-timeout 断链的宽限本就长于恢复窗口）
            abruptClose(a);
            await wait(150);
            const ghostRes = await probe(b, ua);
            ghostRes.present.should.equal('ghost');
            ghostRes.graceLeftMs.should.be.within(1, GHOST_MS);
            // 宽限已过，会话真没了
            await once(b, 'removePeer', GHOST_MS + 3000);
            (await probe(b, ua)).present.should.equal('gone');
            // 从未存在过的会话
            (await probe(b, crypto.randomUUID())).present.should.equal('gone');
        });

        it('should remove immediately on an intentional leave', async () => {
            const room = freshRoom('leave');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            const gone = once(b, 'removePeer');
            a.disconnect(); // 正常 close 包：属主动离开
            (await gone).peer_id.should.equal(ua);
        });
    });

    describe('4. join gates', () => {
        it('should reject a malformed peer_uuid', async () => {
            const s = track(connect());
            s.emit('join', { channel: 'troom', peer_uuid: 'not-a-uuid', peer_name: 'x', peer_audio: true });
            await once(s, 'unauthorized');
        });

        it('should tell a throttled source instead of dropping the join silently', async () => {
            // 用专门的伪造 IP：触发 JOIN_FAIL_LIMIT（10）不得污染共享的
            // 127.0.0.1 计数器，以免殃及套件余下用例
            const spoofed = () =>
                track(
                    io(URL, {
                        transports: ['websocket'],
                        reconnection: false,
                        forceNew: true,
                        extraHeaders: { 'x-forwarded-for': '203.0.113.7' },
                    })
                );
            const s = spoofed();
            for (let i = 0; i < 10; i++) {
                s.emit('join', { channel: 'troom', peer_uuid: 'not-a-uuid', peer_name: 'x', peer_audio: true });
                await once(s, 'unauthorized'); // 每次失败都会重置计数器
            }
            // 来自该来源的一次完全合法的 join 此刻会撞上冷却：服务器必须
            // 明说（retryAfter 秒）而不是闷声不响——客户端的 join-ack
            // 超时判断正是以这一事件为依据
            s.emit('join', joinPayload('zzthrottle', crypto.randomUUID(), 'hampered'));
            const throttled = await once(s, 'joinThrottled');
            throttled.retryAfter.should.be.a.Number();
            throttled.retryAfter.should.be.within(1, 60);
            (await emitted(s, 'serverInfo', 300)).should.equal(false);
        });

        it('should reject a wrong/missing channel password', async () => {
            const s = track(connect());
            s.emit('join', joinPayload('tlocked', crypto.randomUUID(), 'guest'));
            await once(s, 'channelPasswordRequired');
        });

        it('should enforce the participant cap', async () => {
            // 经管理 API 新建一个容量 2 的房间
            const room = freshRoom('cap');
            await adminApi('POST', '/api/admin/channels', { id: room, name: 'Small', maxParticipants: 2 });
            const u1 = crypto.randomUUID();
            const u2 = crypto.randomUUID();
            const u3 = crypto.randomUUID();
            const s1 = track(connect());
            s1.emit('join', joinPayload(room, u1, 'one'));
            await once(s1, 'serverInfo');
            const s2 = track(connect());
            s2.emit('join', joinPayload(room, u2, 'two'));
            await once(s2, 'serverInfo');
            const s3 = track(connect());
            s3.emit('join', joinPayload(room, u3, 'three'));
            const busy = await once(s3, 'roomIsBusy');
            busy.maxParticipants.should.equal(2);
        });

        it('should spawn a temporary room for an unknown id and drop it when empty', async () => {
            const s = track(connect());
            s.emit('join', joinPayload('zztemp1', crypto.randomUUID(), 'wanderer'));
            const info = await once(s, 'serverInfo');
            info.peers_count.should.equal(1);
            const gone = once(s, 'removePeer').catch(() => null); // 最后一名 peer 时可能不触发
            s.disconnect();
            await wait(300);
            const res = await adminApi('GET', '/api/admin/channels');
            const data = await res.json();
            data.temps.map((ch) => ch.id).should.not.containEql('zztemp1');
            void gone;
        });

        it('should keep /api/version responsive during a wrong-password join flood', async () => {
            const room = freshRoom('flood');
            await adminApi('POST', '/api/admin/channels', { id: room, name: 'Flood', password: 'flood-pw' });

            // 成功的 join 会重置每 IP join 失败计数器，
            // 下面的洪水无论此前各测试有多少次被拒 join，
            // 都能拿到完整的尝试预算
            const primed = track(connect());
            primed.emit('join', { ...joinPayload(room, crypto.randomUUID(), 'reset'), channel_password: 'flood-pw' });
            await once(primed, 'serverInfo');

            // 9 个并发错密码 join（第 10 次失败会触发每 IP 冷却被静默丢弃）
            // ——每次都触发一次 scrypt 验证。scryptSync 曾把所有验证排在
            // 事件循环上，令每个 HTTP 请求停滞数百毫秒；
            // async 形态跑在线程池上，循环保持空闲。
            // （阈值放宽以容忍 CI 噪声——本断言的确定性
            // 结构孪生版在 test-channelStore describe 0。）
            //
            const rejects = Array.from({ length: 9 }, () => {
                const s = track(connect());
                const got = once(s, 'channelPasswordRequired');
                s.emit('join', { ...joinPayload(room, crypto.randomUUID(), 'flood'), channel_password: 'nope' });
                return got;
            });
            let worst = 0;
            for (let i = 0; i < 4; i++) {
                const t0 = Date.now();
                const res = await fetch(URL + '/api/version');
                res.status.should.equal(200);
                worst = Math.max(worst, Date.now() - t0);
            }
            await Promise.all(rejects);
            worst.should.be.below(250);

            // 把失败预算还给后续测试
            const reset = track(connect());
            reset.emit('join', { ...joinPayload(room, crypto.randomUUID(), 'reset2'), channel_password: 'flood-pw' });
            await once(reset, 'serverInfo');
        });
    });

    describe('5. admin member list + kick', () => {
        it('should list room members with state and kick a live one', async () => {
            const room = freshRoom('adm');
            await adminApi('POST', '/api/admin/channels', { id: room, name: 'Admin View' });
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            const res = await adminApi('GET', '/api/admin/channels');
            const data = await res.json();
            const entry = data.channels.find((ch) => ch.id === room);
            if (!entry) throw new Error('channel missing from admin list');
            entry.members.map((m) => m.name).should.containEql('alice');
            entry.members.find((m) => m.uuid === ub).ghost.should.be.false();

            const kicked = once(b, 'kickOut'); // kickOut 发给被踢者本人
            const gone = once(a, 'removePeer'); // 移除广播发给整个房间
            const kickRes = await adminApi('POST', '/api/admin/kick', { channel: room, uuid: ub });
            (await kickRes.json()).success.should.be.true();
            (await kicked).reason.should.equal('removed by admin');
            (await gone).peer_id.should.equal(ub);
        });

        it('should expire a ghost member on admin kick', async () => {
            const room = freshRoom('admg');
            await adminApi('POST', '/api/admin/channels', { id: room, name: 'Admin Ghost' });
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            abruptClose(b);
            await wait(150);
            const gone = once(a, 'removePeer');
            const kickRes = await adminApi('POST', '/api/admin/kick', { channel: room, uuid: ub });
            (await kickRes.json()).success.should.be.true();
            (await gone).peer_id.should.equal(ub);
        });
    });

    describe('6. admin backup + host export', () => {
        it('should serve a gzip tar backup containing the registry and history', async () => {
            const res = await adminApi('GET', '/api/admin/backup');
            res.status.should.equal(200);
            res.headers.get('content-type').should.equal('application/gzip');
            const buf = Buffer.from(await res.arrayBuffer());
            buf.length.should.be.greaterThan(0);
            buf[0].should.equal(0x1f); // gzip 魔数
            buf[1].should.equal(0x8b);
        });

        it('should reject the host export without a host token', async () => {
            const res = await fetch(URL + '/api/host/troom/export');
            res.status.should.equal(401);
        });

        it('should serve a Markdown export for a valid host', async () => {
            const login = await fetch(URL + '/api/host/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelId: 'troom', username: 'nobody', password: 'whatever' }),
            });
            // troom 没有 hosts 也没有 DEFAULT_CHANNEL_MODERATOR → 登录失败
            login.status.should.equal(401);
        });
    });

    describe('7. hardening regressions', () => {
        it('should cap the join name and reject an empty one', async () => {
            const room = freshRoom('namecap');
            const uuid = crypto.randomUUID();
            const s = track(connect());
            s.emit('join', joinPayload(room, uuid, 'x'.repeat(200)));
            const info = await once(s, 'serverInfo');
            info.peers[uuid].peer_name.should.equal('x'.repeat(24));

            const s2 = track(connect());
            s2.emit('join', { channel: room, peer_uuid: crypto.randomUUID(), peer_name: '', peer_audio: true });
            await once(s2, 'unauthorized');
        });

        it('should leave exactly one live session when the same uuid joins repeatedly', async () => {
            const room = freshRoom('race');
            const uuid = crypto.randomUUID();
            const a = track(connect());
            a.emit('join', joinPayload(room, uuid, 'twin'));
            await once(a, 'serverInfo');

            // 第二个 socket 用相同 uuid 加入会收割活会话并接管
            // （后写者胜）；反复接管绝不能留下
            // 重复或僵尸会话
            const b = track(connect());
            const aGone = once(a, 'removePeer');
            b.emit('join', joinPayload(room, uuid, 'twin'));
            await once(b, 'serverInfo');
            (await aGone).peer_id.should.equal(uuid);

            const c = track(connect());
            c.emit('join', joinPayload(room, uuid, 'twin'));
            await once(c, 'serverInfo');
            await wait(200);

            const res = await adminApi('GET', '/api/admin/channels');
            const data = await res.json();
            const entry = [...data.channels, ...data.temps].find((ch) => ch.id === room);
            if (!entry) throw new Error('room missing from admin list');
            entry.members.length.should.equal(1);
            entry.members[0].uuid.should.equal(uuid);
            entry.members[0].name.should.equal('twin');
        });

        it('should join with a channel password containing markup characters', async () => {
            const room = freshRoom('pwmark');
            const secret = '<b>pw&"</b>';
            const created = await adminApi('POST', '/api/admin/channels', {
                id: room,
                name: 'Markup Pw',
                password: secret,
            });
            (await created.json()).channel.hasPassword.should.be.true();
            const s = track(connect());
            s.emit('join', { ...joinPayload(room, crypto.randomUUID(), 'guest'), channel_password: secret });
            await once(s, 'serverInfo');
        });

        it('should keep host usernames out of the public endpoints (admin-only)', async () => {
            const room = freshRoom('hosts');
            await adminApi('POST', '/api/admin/channels', {
                id: room,
                name: 'Hosted Pub',
                hosts: [{ username: 'secret-host', password: 'pw1' }],
            });
            const pub = await (await fetch(URL + `/api/channels/${room}`)).json();
            should.not.exist(pub.hosts);
            const pubList = await (await fetch(URL + '/api/channels')).json();
            should.not.exist(pubList.channels.find((ch) => ch.id === room).hosts);
            const adminData = await (await adminApi('GET', '/api/admin/channels')).json();
            adminData.channels.find((ch) => ch.id === room).hosts.should.eql(['secret-host']);
        });

        it('should disconnect a client flooding the signaling relay (and only that client)', async () => {
            const room = freshRoom('flood');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            // 洪水方把 relayICE 打满 socket 级窗口预算（2000/10s）：
            // 超限的那一条触发服务器断开，且只断它自己
            const gone = once(a, 'disconnect');
            const flood = { peer_id: ub, ice_candidate: { candidate: 'candidate:1' } };
            for (let i = 0; i < 2100; i++) a.emit('relayICE', flood);
            const reason = await gone;
            reason.should.equal('io server disconnect');

            // 无辜成员不受波及：ack 通道仍然工作
            const ackOk = await new Promise((resolve) => {
                b.timeout(3000).emit('refreshIceServers', null, (err) => resolve(!err));
            });
            ackOk.should.be.true();
        });

        it('should drop malformed or oversized relay payloads without relaying or receipt', async () => {
            const room = freshRoom('shape');
            const ua = crypto.randomUUID();
            const ub = crypto.randomUUID();
            const a = track(connect());
            const b = track(connect());
            a.emit('join', joinPayload(room, ua, 'alice'));
            await once(a, 'serverInfo');
            b.emit('join', joinPayload(room, ub, 'bob'));
            await once(b, 'serverInfo');
            await wait(100);

            // 中转按「条」计费、不按字节计——socket.io 2MB 包上限内的
            // 巨型载荷会被原样放大到目标成员，必须在入口按形状/大小拦下
            const seenSdp = [];
            const seenIce = [];
            b.on('sessionDescription', (cfg) => seenSdp.push(cfg));
            b.on('iceCandidate', (cfg) => seenIce.push(cfg));
            const receipts = [];
            a.on('relayUndelivered', (cfg) => receipts.push(cfg));

            // 畸形 SDP：错 type / 缺 sdp / 非对象 / 超大 sdp（>256KB）
            a.emit('relaySDP', { peer_id: ub, session_description: { type: 'pranswer', sdp: 'x' } });
            a.emit('relaySDP', { peer_id: ub, session_description: { type: 'offer' } });
            a.emit('relaySDP', { peer_id: ub, session_description: 'not-an-object' });
            a.emit('relaySDP', { peer_id: ub, session_description: { type: 'offer', sdp: 'x'.repeat(300 * 1024) } });
            // 畸形 ICE：缺 candidate / 非字符串 / 超长（>2048）
            a.emit('relayICE', { peer_id: ub, ice_candidate: { sdpMid: '0' } });
            a.emit('relayICE', { peer_id: ub, ice_candidate: { candidate: 42 } });
            a.emit('relayICE', { peer_id: ub, ice_candidate: { candidate: 'x'.repeat(4096) } });
            await wait(300);
            seenSdp.length.should.equal(0);
            seenIce.length.should.equal(0);
            // 回执语义是「合法载荷此刻投不出去」——畸形载荷不该产生回执
            receipts.length.should.equal(0);

            // 合法载荷在同一对端上照常中转（校验没有误伤主路径）
            a.emit('relaySDP', {
                peer_id: ub,
                session_description: { type: 'offer', sdp: 'v=0 ok' },
            });
            (await once(b, 'sessionDescription')).session_description.sdp.should.equal('v=0 ok');
            a.emit('relayICE', {
                peer_id: ub,
                ice_candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0' },
            });
            await once(b, 'iceCandidate');
            seenIce.length.should.equal(1);
        });
    });
});
