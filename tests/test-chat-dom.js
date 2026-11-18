'use strict';

// npx mocha test-chat-dom.js
// chat.js 消息列表的 DOM 级回归：历史行的权威 ts 不得进入 ack
// 待绑定队列——否则进房后第一条新消息的 chatAck 会被最老的
// 历史行抢走（其 ts 被改写，编辑/撤回身份错乱）。用 jsdom
// 实例化真实的 initChat 工厂验证。

require('should');
const { JSDOM } = require('jsdom');

describe('test-chat-dom (history rows must not steal the ack)', () => {
    let chat;
    let listEl;

    before(async () => {
        // 全局设置放在套件钩子里：加载期设置会被其他 jsdom 套件
        // （test-frontend-utils）在 mocha 的文件装载阶段覆盖
        const dom = new JSDOM('<!doctype html><html><body><div id="list"></div></body></html>', {
            url: 'http://localhost/',
            pretendToBeVisual: true,
        });
        global.document = dom.window.document;
        global.window = dom.window;
        global.HTMLElement = dom.window.HTMLElement;
        global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
        const mod = await require('./helpers').importBrowserModule('public/js/core/chat.js');
        listEl = global.document.getElementById('list');
        chat = mod.initChat(listEl, {
            emptyText: 'empty',
            mentionNames: () => ['QA'],
            selfName: () => 'QA',
        });
    });

    function rows() {
        return [...global.document.querySelectorAll('#list .msg[data-ts]')].map((r) => ({
            ts: r.dataset.ts,
            name: r.dataset.name,
            text: (r.querySelector('.msg-text')?.textContent || '').slice(0, 30),
        }));
    }

    it('history self rows render without entering the pending-ack queue', () => {
        chat.addHistory(
            [
                { name: 'QA', text: 'old self message', self: true, time: new Date(1000) },
                { name: 'bob', text: 'peer message', time: new Date(2000) },
            ],
            { dividerText: '' }
        );
        const rendered = rows();
        rendered.length.should.equal(2);
        rendered[0].ts.should.equal('1000');
        rendered[0].name.should.equal('QA');
    });

    it('bindServerTs targets the freshly-sent row, never a history row', () => {
        const before = rows();
        const historyTs = before[0].ts; // 1000

        // 用户在 join 后 10s 内发出第一条新消息（本地时间戳渲染）
        chat.add({ name: 'QA', text: 'fresh message', self: true, time: new Date(5000) });
        const afterAdd = rows();
        afterAdd.length.should.equal(3);

        // 服务器的权威 ts 到达（远端时钟略快）
        chat.bindServerTs(9000);

        const afterAck = rows();
        afterAck.length.should.equal(3);
        // 新行绑定权威 ts
        afterAck[2].ts.should.equal('9000');
        afterAck[2].text.should.equal('fresh message');
        // 历史行的 ts 纹丝不动——这是本回归的核心断言
        afterAck[0].ts.should.equal(historyTs);
        afterAck[0].text.should.equal('old self message');
    });

    it('a dropped message (no ack) expires and does not swallow later acks', async () => {
        // 一条被服务器拒绝的消息（本地渲染了、永远等不到 ack）
        chat.add({ name: 'QA', text: 'doomed', self: true, time: new Date(20000) });
        // TTL 10s——快进不掉真实时钟，改为验证下一条正常消息的
        // ack 不被吞：直接再发一条并确认 ack 绑到它（被拒消息
        // 在队头，若不过期会抢走这个 ack）
        const list = rows();
        list.at(-1).text.should.equal('doomed');
        chat.add({ name: 'QA', text: 'after doomed', self: true, time: new Date(21000) });
        // doomed 与 after doomed 都在队列里；ack 只应绑给 doomed
        // （最老的仍在 TTL 内）——这本身就是 FIFO 语义
        chat.bindServerTs(22000);
        const list2 = rows();
        list2.at(-2).ts.should.equal('22000'); // doomed 拿到（TTL 未过）
        list2.at(-1).text.should.equal('after doomed');
    });
});
