'use strict';

// npx mocha test-socket-events.js
// socket 接线的纯逻辑回归：removePeer 处理器对「离开者本人」的
// uuid 必须无操作——服务器在 B1 主动断开与同 uuid 新连接抢占旧连接
// （reapSession）时，都会经 broadcastRemovePeer 的专线把
// removePeer(自己的 uuid) 发给自己的 socket；自己的卡片归
// syncMembers/ensureSelfMember 管，误拆会让 B1 重连后自己的卡片
// 消失（serverInfo 的重连分支不重同步花名册），还会对自己播
// 「已离开」+ 音效。

require('should');
const { importBrowserModule } = require('./helpers');

describe('test-socket-events (removePeer must ignore the self session)', () => {
    const SELF = '11111111-1111-1111-1111-111111111111';
    const PEER = '22222222-2222-2222-2222-222222222222';
    let handlers;
    let dropped;
    let chatLines;
    let sounds;
    let members;

    before(async () => {
        const mod = await importBrowserModule('public/js/pages/channel/socketEvents.js');
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        handlers = {};
        dropped = [];
        chatLines = [];
        sounds = [];
        const socket = { on: (ev, fn) => (handlers[ev] = fn) };
        members = new Map([
            [SELF, { peer_name: 'me' }],
            [PEER, { peer_name: 'B' }],
        ]);
        const s = {
            selfUuid: SELF,
            joined: true,
            socket,
            mesh: { entries: new Map() },
            chat: { add: (row) => chatLines.push(row) },
        };
        const mem = {
            dropPeer: (id) => dropped.push(id),
            updateOnlineCount() {},
        };
        const se = mod.createSocketEvents({
            s,
            x: {},
            rec: {},
            mem,
            members,
            avatars: new Map(),
            peerVolumes: {},
            channelId: 'testroom',
            NICK_KEY: 'vc_nick',
            AVATAR_MAX_CHARS: 96 * 1024,
            DATA_URL_RE: /^data:image\//,
            validReply: () => null,
            screenLock: { sync() {} },
            playSound: (name) => sounds.push(name),
            toast() {},
            t: (key) => key,
            $: () => ({ classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} }),
        });
        se.registerSocketHandlers();
    });

    it('must not drop the own card when the server echoes our own removal (B1 / reap)', () => {
        handlers.removePeer({ peer_id: SELF });
        dropped.should.eql([]);
        chatLines.should.eql([]);
        sounds.should.eql([]);
        members.has(SELF).should.equal(true);
    });

    it('must still drop real peers with the leave line and sound', () => {
        handlers.removePeer({ peer_id: PEER });
        dropped.should.eql([PEER]);
        chatLines.should.have.length(1);
        chatLines[0].system.should.equal(true);
        sounds.should.eql(['peerLeave']);
    });

    it('must ignore malformed payloads (empty peer_id) without touching the roster', () => {
        handlers.removePeer({});
        handlers.removePeer({ peer_id: null });
        dropped.should.eql([PEER]); // 没有新增
    });
});
