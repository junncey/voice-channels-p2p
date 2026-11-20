'use strict';

// npx mocha test-frontend-utils.js
// 前端纯逻辑模块的单测：core/utils.js（DOM 构建/格式化/键盘助记）
// 与 pages/channel/hostAuth.js 的存储读取函数（localStorage 门面）。

require('should');
const { JSDOM } = require('jsdom');

let utils;
let hostAuth;

before(async () => {
    // 全局设置放在套件钩子里：加载期设置会被其他 jsdom 套件
    // （test-chat-dom）在 mocha 的文件装载阶段覆盖
    const dom = new JSDOM('<!doctype html><html><body><div id="a" class="x"><span>hi</span></div></body></html>', {
        url: 'http://localhost/', // jsdom 的 localStorage 不为 opaque origin 提供
    });
    global.document = dom.window.document;
    global.window = dom.window;
    global.localStorage = dom.window.localStorage;
    global.sessionStorage = dom.window.sessionStorage;
    const importBrowserModule = require('./helpers').importBrowserModule;
    utils = await importBrowserModule('public/js/core/utils.js');
    hostAuth = await importBrowserModule('public/js/pages/channel/hostAuth.js');
});

describe('test-frontend-utils (core/utils.js)', () => {
    it('el() builds text-only nodes and applies props/children', () => {
        const node = utils.el('div', { class: 'box', title: 't' }, 'hello', utils.el('b', {}, 'bold'));
        node.tagName.should.equal('DIV');
        node.className.should.equal('box');
        node.childNodes.length.should.equal(2);
        node.childNodes[0].textContent.should.equal('hello');
        node.childNodes[1].textContent.should.equal('bold');
        // text-only：绝不经 innerHTML
        node.innerHTML.should.not.containEql('&lt;');
        const evil = utils.el('div', {}, '<img src=x onerror=1>');
        evil.textContent.should.equal('<img src=x onerror=1>');
        (evil.querySelector('img') === null).should.be.true();
    });

    it('el() keeps value/style/object props and strips null/undefined children', () => {
        const input = utils.el('input', { type: 'text', value: 'v' });
        input.value.should.equal('v');
        const styled = utils.el('div', { style: { color: 'red' } });
        styled.style.color.should.equal('red');
        const sparse = utils.el('div', {}, null, 'keep', undefined);
        sparse.childNodes.length.should.equal(1);
    });

    it('formatTime/formatDate zero-pad by local clock', () => {
        const when = new Date(2026, 0, 5, 3, 4);
        utils.formatTime(when).should.equal('03:04');
        utils.formatDate(when).should.equal('01-05 03:04');
    });

    it('avatarColor is deterministic per name and spread across hues', () => {
        utils.avatarColor('alice').should.equal(utils.avatarColor('alice'));
        utils.avatarColor('alice').should.not.equal(utils.avatarColor('bob'));
        utils.avatarColor('alice').should.startWith('hsl(');
        utils.avatarColor('').should.startWith('hsl('); // 空名也有底色
    });

    it('MENTION_BOUNDARY rejects a following word character', () => {
        new RegExp(`@alice${utils.MENTION_BOUNDARY}`, 'u').test('@alice!').should.be.true();
        new RegExp(`@alice${utils.MENTION_BOUNDARY}`, 'u').test('@alice2').should.be.false();
        new RegExp(`@王${utils.MENTION_BOUNDARY}`, 'u').test('@王，早').should.be.true();
    });

    it('keyboard helpers normalize PTT keys and labels', () => {
        utils.isModifierCode('ShiftLeft').should.be.true();
        utils.isModifierCode('KeyA').should.be.false();
        utils.keyLabel('Space').should.be.a.String();
        utils.normalizePttKey('Space').should.equal('Space');
    });

    it('sanitizePeerVolumes keeps finite in-range values and clamps outliers', () => {
        utils
            .sanitizePeerVolumes({ alice: 0.5, bob: '1.5', carol: 7, dave: -2, erin: 0, 'frank x': 3 })
            .should.eql({ alice: 0.5, bob: 1.5, carol: 3, dave: 0, erin: 0, 'frank x': 3 });
    });

    it('sanitizePeerVolumes drops non-object payloads and non-finite/absent/unity entries', () => {
        utils.sanitizePeerVolumes('{"alice":0.5}').should.eql({});
        utils.sanitizePeerVolumes(null).should.eql({});
        utils.sanitizePeerVolumes([0.5]).should.eql({});
        utils
            .sanitizePeerVolumes({ alice: 'abc', bob: null, carol: {}, dave: NaN, unity: 1, '': 0.5, lone: undefined })
            .should.eql({});
    });
});

describe('test-frontend-utils (hostAuth storage reads)', () => {
    // 迷你 JWT：payload 用 base64url 编码 {exp}
    const fakeJwt = (expMs) => {
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url');
        return `h.${payload}.s`;
    };

    it('loadHostToken keeps a live JWT, forgets expired/garbage ones', () => {
        hostAuth.loadHostToken('room-none').should.equal(''); // 无存储 → 空串

        const live = fakeJwt(Date.now() + 60_000);
        localStorage.setItem('vc_host_token_room-live', live);
        hostAuth.loadHostToken('room-live').should.equal(live);

        // 过期即忘（顺带清掉存储）
        localStorage.setItem('vc_host_token_room-old', fakeJwt(Date.now() - 1000));
        hostAuth.loadHostToken('room-old').should.equal('');
        (localStorage.getItem('vc_host_token_room-old') === null).should.be.true();

        // 畸形值绝不抛
        localStorage.setItem('vc_host_token_room-bad', '{oops');
        hostAuth.loadHostToken('room-bad').should.equal('');
    });

    it('loadChannelPw reads the per-channel remembered password', () => {
        hostAuth.loadChannelPw('room-pw').should.equal(''); // 缺省空串
        localStorage.setItem('vc_chan_pw_room-pw', 'secret');
        hostAuth.loadChannelPw('room-pw').should.equal('secret');
    });
});
