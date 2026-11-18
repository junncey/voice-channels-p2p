'use strict';

// npx mocha test-limits.js
// 线格式常量（limits.js）与请求载荷工具（payload.js）的单测，
// 外加「服务端 limits ↔ 客户端 images.js 镜像常量」的对齐断言——
// 把「改一处必须同步另一处」的人工纪律变成机器保证。

require('should');

const limits = require('../app/src/limits');
const {
    sanitizeExceptSecrets,
    sanitizeChannelPayload,
    isImageDataUrl,
    hostTokenValidFor,
} = require('../app/src/payload');

describe('test-limits (wire format constants)', () => {
    it('channel id pattern accepts valid ids and rejects meta-key collisions', () => {
        'abc123'.should.match(limits.CHANNEL_ID_RE);
        'a-b_C9'.should.match(limits.CHANNEL_ID_RE);
        'ab'.should.not.match(limits.CHANNEL_ID_RE); // 太短
        'a'.repeat(33).should.not.match(limits.CHANNEL_ID_RE); // 太长
        'lock'.should.match(limits.CHANNEL_ID_RE); // 合法频道 id（元键防护靠 uuid 形状，不在 id 正则）
        'a/b'.should.not.match(limits.CHANNEL_ID_RE); // 路径穿越
        '../x'.should.not.match(limits.CHANNEL_ID_RE);
    });

    it('image data-url whitelist accepts the four mimes and rejects everything else', () => {
        const ok = (mime) => `data:${mime};base64,QUJD`.should.match(limits.IMAGE_DATA_URL_RE);
        ok('image/jpeg');
        ok('image/png');
        ok('image/gif');
        ok('image/webp');
        'data:image/svg+xml;base64,QUJD'.should.not.match(limits.IMAGE_DATA_URL_RE); // SVG 绝不放行
        'data:text/html;base64,QUJD'.should.not.match(limits.IMAGE_DATA_URL_RE);
        'javascript:alert(1)'.should.not.match(limits.IMAGE_DATA_URL_RE);
        'data:image/jpeg;base64,QUJD '.should.not.match(limits.IMAGE_DATA_URL_RE); // 尾随空白
    });

    it('exposes documented numeric caps consistently', () => {
        limits.PEER_NAME_MAX.should.equal(24);
        limits.CHAT_TEXT_MAX.should.equal(500);
        limits.REPLY_TEXT_MAX.should.equal(80);
        limits.REACTION_EMOJI_MAX.should.equal(16);
        limits.REACTIONS_MAX_EMOJI.should.equal(8);
        limits.REACTIONS_MAX_NAMES.should.equal(50);
        limits.MAX_IMAGES_PER_MESSAGE.should.equal(9);
        limits.IMG_BATCH_ID_MAX.should.equal(64);
        limits.IMAGE_MAX_CHARS.should.equal(1600 * 1024);
        limits.AVATAR_MAX_CHARS.should.equal(96 * 1024);
    });
});

describe('test-limits (server ↔ client mirror alignment)', () => {
    it('limits constants stay in sync with public/js/core/images.js', async () => {
        const images = await require('./helpers').importBrowserModule('public/js/core/images.js');
        images.MAX_TRANSFER_CHARS.should.equal(limits.IMAGE_MAX_CHARS);
        String(images.DATA_URL_RE).should.equal(String(limits.IMAGE_DATA_URL_RE));
        // 客户端文件选择上限是本地约束（与服务端单图上限不同源），
        // 但必须存在且为正——它决定 composer/settings 的拒绝阈值
        images.MAX_FILE_BYTES.should.be.above(0);
    });
});

describe('test-payload (sanitizeExceptSecrets / channel payload)', () => {
    it('keeps secret fields verbatim (even with markup characters)', () => {
        const password = 'p<a&ss>"w0rd';
        const out = sanitizeExceptSecrets({ name: 'hello <b>', password, extra: 1 }, ['password']);
        out.password.should.equal(password); // 原文——哈希/比对绝不能被 DOMPurify 改写
        out.name.should.not.containEql('<b>'); // 其余照常清洗
    });

    it('returns {} for non-object input', () => {
        sanitizeExceptSecrets(null, ['password']).should.eql({});
        sanitizeExceptSecrets('x', ['password']).should.eql({});
    });

    it('channel payload exempts channel + host passwords but sanitizes hostnames', () => {
        const out = sanitizeChannelPayload({
            name: 'chan<script>',
            password: 's3cr<et',
            hosts: [{ username: 'host<script>', password: 'pw<>&' }],
        });
        out.password.should.equal('s3cr<et');
        out.name.should.not.containEql('<script>');
        out.hosts[0].password.should.equal('pw<>&');
        out.hosts[0].username.should.not.containEql('<script>');
    });
});

describe('test-payload (isImageDataUrl / hostTokenValidFor)', () => {
    it('isImageDataUrl enforces the length cap per use case', () => {
        const tiny = 'data:image/png;base64,QUJD';
        isImageDataUrl(tiny).should.be.true();
        isImageDataUrl('javascript:x').should.be.false();
        isImageDataUrl('').should.be.false();
        isImageDataUrl(null).should.be.false();
        const long = `data:image/png;base64,${'A'.repeat(limits.IMAGE_MAX_CHARS)}`;
        isImageDataUrl(long).should.be.false(); // 超聊天图上限
        isImageDataUrl(long, long.length + 1).should.be.true(); // 调大上限后通过
        const avatar = `data:image/png;base64,${'A'.repeat(limits.AVATAR_MAX_CHARS + 1)}`;
        isImageDataUrl(avatar, limits.AVATAR_MAX_CHARS).should.be.false();
    });

    it('hostTokenValidFor requires role/channel/username and a still-configured host', () => {
        const channelsCfg = { defaultModerator: false };
        const channelStore = {
            isHost: (id, user) => user === 'alice',
            isHostless: () => false,
        };
        const base = { role: 'host', channelId: 'room1', username: 'alice' };
        hostTokenValidFor(base, 'room1', { channelsCfg, channelStore }).should.be.true();
        hostTokenValidFor({ ...base, channelId: 'room2' }, 'room1', { channelsCfg, channelStore }).should.be.false();
        hostTokenValidFor({ ...base, role: 'admin' }, 'room1', { channelsCfg, channelStore }).should.be.false();
        hostTokenValidFor({ ...base, username: 'bob' }, 'room1', { channelsCfg, channelStore }).should.be.false(); // 已被移出 hosts
        hostTokenValidFor(null, 'room1', { channelsCfg, channelStore }).should.be.false();
    });

    it('hostTokenValidFor honors the default-moderator fallback only while hostless and enabled', () => {
        const mk = (hostless, enabled) => ({
            channelsCfg: { defaultModerator: enabled },
            channelStore: { isHost: () => false, isHostless: () => hostless },
        });
        const token = { role: 'host', channelId: 'room1', username: 'x', via: 'default-moderator' };
        hostTokenValidFor(token, 'room1', mk(true, true)).should.be.true();
        hostTokenValidFor(token, 'room1', mk(false, true)).should.be.false(); // 频道已有主人
        hostTokenValidFor(token, 'room1', mk(true, false)).should.be.false(); // 回退被关掉
        hostTokenValidFor({ ...token, via: 'configured' }, 'room1', mk(true, true)).should.be.false(); // 非 fallback token
    });
});
