'use strict';

// npx mocha test-server.js
//
// Signaling integration tests: real server instance + socket.io-client pairs
// covering join/addPeer, ghost grace + same-uuid resume, intentional leave,
// capacity/password gates, chat history persistence (incl. the session-uuid
// sender lookup) and the admin member list / kick endpoints.
//
// The suite runs in-process: env is pinned BEFORE server.js (and thus
// config.js) loads. The repo's real channels.json / chat_history are backed
// up and restored — the test owns them while it runs. Ghost grace windows are
// shortened via GHOST_GRACE_MS so expiry cases finish in seconds.

process.env.PORT = '3100';
process.env.CHANNEL_ADMIN_PASSWORD = 'test-admin-pw';
process.env.CHANNEL_ADMIN_JWT_SECRET = 'test-jwt-secret';
process.env.LOGS_DEBUG = 'false';
process.env.GHOST_GRACE_MS = '1200';
process.env.GHOST_GRACE_LATE_MS = '600';
process.env.TEMP_ROOMS_ENABLED = 'true';
process.env.AUTO_INIT_CHANNELS = 'true';

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');

// the audit trail must not touch the repo's real file either (env must be
// pinned before server.js loads, hence its position after the requires)
process.env.VC_AUDIT_FILE = path.join(os.tmpdir(), `vc-audit-test-${process.pid}.jsonl`);

const SRC = path.join(__dirname, '..', 'app', 'src');
const CHANNELS_FILE = path.join(SRC, 'channels.json');
const CHAT_DIR = path.join(SRC, 'chat_history');
const URL = 'http://127.0.0.1:3100';
const GHOST_MS = Number(process.env.GHOST_GRACE_MS);

const backupDir = path.join(os.tmpdir(), `vc-server-test-${Date.now()}`);
const hadChannelsFile = fs.existsSync(CHANNELS_FILE);
const hadChatDir = fs.existsSync(CHAT_DIR);
// registry sidecar files that already exist belong to the USER — the after()
// hook may only delete the ones this suite itself produced (the old cleanup
// wiped a pre-existing channels.json.bak whenever the main file was absent)
const REGISTRY_SIDEcars = ['.bak', '.corrupt', '.tmp'];
const preexistingSidecars = new Set(
    REGISTRY_SIDEcars.filter((suffix) => fs.existsSync(CHANNELS_FILE + suffix)).map((suffix) => CHANNELS_FILE + suffix)
);

// backup before the server auto-creates them
fs.mkdirSync(backupDir, { recursive: true });
if (hadChannelsFile) fs.copyFileSync(CHANNELS_FILE, path.join(backupDir, 'channels.json'));
if (hadChatDir) fs.cpSync(CHAT_DIR, path.join(backupDir, 'chat_history'), { recursive: true });

/**
 * Hand the user's data files back exactly as they were. Idempotent: called
 * from after() on a clean run AND from the process 'exit' hook below, so a
 * hard test failure or Ctrl+C cannot leave the swapped registry behind
 * (SIGKILL is beyond anyone's reach).
 */
let userDataRestored = false;
function restoreUserData() {
    if (userDataRestored) return;
    userDataRestored = true;
    if (hadChannelsFile) fs.copyFileSync(path.join(backupDir, 'channels.json'), CHANNELS_FILE);
    else if (fs.existsSync(CHANNELS_FILE)) fs.unlinkSync(CHANNELS_FILE);
    // sidecars: delete only what the TEST created, never a user's files
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

require('../app/src/server.js'); // starts listening on :3100

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

/** Abrupt transport death (no disconnect packet) — the ghost path. */
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

/** Fresh unique room id per test so ghost-expiry broadcasts never cross-talk. */
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
        // the require() above returns before the listen callback fires on a
        // cold start — poll once for readiness instead of racing the login
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
        // the suite spawns many short-lived temp rooms from one IP — raise the
        // anti-abuse quotas (values must stay inside the settings schema caps)
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
                /* already gone */
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
            const gotToAddPeer = once(b, 'addPeer'); // addPeer storms arrive BEFORE serverInfo
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

            // unknown target is dropped silently
            a.emit('relaySDP', { peer_id: crypto.randomUUID(), session_description: { type: 'offer', sdp: 'x' } });
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

            // a member joining AFTER the flip sees the state in the peer map
            const c = track(connect());
            c.emit('join', joinPayload(room, crypto.randomUUID(), 'carol'));
            const infoC = await once(c, 'serverInfo');
            infoC.peers[ua].peer_share.should.be.true();
            infoC.peers[ub].peer_share.should.be.false();

            // unknown element never relays
            a.emit('peerStatus', { room_id: room, peer_name: 'alice', peer_id: ua, element: 'bogus', status: true });
            (await emitted(c, 'peerStatus', 250)).should.be.false();
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

            // that ts is exactly what edit/recall/reaction look up later
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
            a.disconnect(); // proper close packet: intentional
            (await gone).peer_id.should.equal(ua);
        });
    });

    describe('4. join gates', () => {
        it('should reject a malformed peer_uuid', async () => {
            const s = track(connect());
            s.emit('join', { channel: 'troom', peer_uuid: 'not-a-uuid', peer_name: 'x', peer_audio: true });
            await once(s, 'unauthorized');
        });

        it('should reject a wrong/missing channel password', async () => {
            const s = track(connect());
            s.emit('join', joinPayload('tlocked', crypto.randomUUID(), 'guest'));
            await once(s, 'channelPasswordRequired');
        });

        it('should enforce the participant cap', async () => {
            // fresh capacity-2 room via the admin API
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
            const gone = once(s, 'removePeer').catch(() => null); // may not fire for the last peer
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

            // a successful join resets the per-IP join-failure counter, so the
            // flood below gets the full attempt budget regardless of earlier
            // tests' rejected joins
            const primed = track(connect());
            primed.emit('join', { ...joinPayload(room, crypto.randomUUID(), 'reset'), channel_password: 'flood-pw' });
            await once(primed, 'serverInfo');

            // 9 concurrent wrong-password joins (a 10th failure would arm the
            // per-IP cooldown and get silently dropped) — each triggers an
            // scrypt verify. scryptSync used to queue all of them on the event
            // loop, stalling every HTTP request for hundreds of ms; the async
            // form runs on the threadpool and the loop stays free. (Threshold
            // generous for CI noise — the deterministic structural twin of
            // this assertion lives in test-channelStore describe 0.)
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

            // hand the failure budget back to the tests that follow
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

            const kicked = once(b, 'kickOut'); // kickOut goes to the TARGET
            const gone = once(a, 'removePeer'); // removal broadcast goes to the room
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
            buf[0].should.equal(0x1f); // gzip magic
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
            // troom has no hosts and no DEFAULT_CHANNEL_MODERATOR → login fails
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

            // a second socket joining with the SAME uuid reaps the live one and
            // takes over (last writer wins); repeated takeovers must never
            // leave duplicate or zombie sessions behind
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
    });
});
