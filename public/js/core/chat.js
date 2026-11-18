/**
 * 聊天消息列表——QQ 风格气泡（头像贴着带尾角的气泡，
 * 他人昵称在气泡上方，时间分隔居中）。
 * 纯文本（全部走 textContent，不注入 HTML；图片/头像
 * 源必须是校验过的 data:image URL——我们从不内插 HTML）。
 *
 * 送达后的消息生命周期（编辑/撤回/emoji 回应）由
 * editMessage/deleteMessage/reactMessage 原地应用——服务器把
 * 持久化结果广播给包括发送者在内的所有人，
 * DOM 跟随存储，而不信任本地回显。
 */

import { el, formatTime, formatDate } from './utils.js';
import { DATA_URL_RE } from './images.js';
import { buildAvatarNode } from './avatar.js';
import { openEmojiPicker } from './emoji.js';
import { validReply, validImages, validReactions, createTextRenderers, createLightbox } from './chatShared.js';

// 兼容既有导入方（channel.js）：纯工具改由 chatShared 提供
export { escapeRegExp, validReply } from './chatShared.js';

/** 与上一条消息的间隔超过此值时显示时间分隔。 */
const TIME_GAP_MS = 5 * 60 * 1000;

/**
 * @param {HTMLElement} container 可滚动的消息列表
 * @param {object} [options]
 * @param {string}  [options.emptyText] 列表为空时显示的占位文本 * @param {string}  [options.downloadText] 灯箱保存图片按钮文案
 * @param {string}  [options.yesterdayText] 「昨天」时间分隔标签
 * @param {string}  [options.todayText] 「今天」日分隔标签
 * @param {function(Date): string} [options.dayText] 日分隔标签（更早日期）
 * @param {string}  [options.deletedText] 撤回消息的墓碑文案
 * @param {string}  [options.editedText] 「（已编辑）」标记
 * @param {function(string):string} [options.avatarFor] 昵称 -> 自定义头像 data URL（'' = 无）
 * @param {function(number, number):string} [options.imagesProgress] (got, total) -> 进度文案
 * @param {string}  [options.failText] 批次内所有图片都失败时的提示
 * @param {string}  [options.historyLoadingText] 上滚分页加载中的提示行
 * @param {string}  [options.historyEndText] 上滚分页到达历史尽头的提示行
 * @param {function(): string[]} [options.mentionNames] 用于 @高亮的在线成员名
 * @param {function(): string} [options.selfName] 本地用户的显示名
 * @param {function(): boolean} [options.isHost] 主持人权限（可撤回任何人的消息）
 * @param {function(object): void} [options.onReply] ({name, text, ts})——回复按钮被点击
 * @param {function(object): void} [options.onEdit] ({name, text, ts})——编辑按钮被点击
 * @param {function(object): void} [options.onDelete] ({name, ts})——撤回按钮被点击
 * @param {function(object): void} [options.onReact] ({name, ts, emoji, on})——回应被切换
 * @param {function(number): string} [options.jumpNewText] (n) -> 「n 条新消息」胶囊文案
 * @param {string}  [options.jumpText] 回到底部胶囊文案
 */
export function initChat(
    container,
    {
        emptyText = '',
        downloadText = 'Save',
        yesterdayText = '昨天',
        todayText = '今天',
        dayText = null,
        deletedText = '',
        editedText = '',
        avatarFor = null,
        imagesProgress = (got, total) => `${got}/${total}`,
        failText = '',
        historyLoadingText = '',
        historyEndText = '',
        mentionNames = () => [],
        selfName = () => '',
        isHost = () => false,
        onReply = null,
        onEdit = null,
        onDelete = null,
        onReact = null,
        jumpNewText = (n) => `${n}`,
        jumpText = '↓',
    } = {}
) {
    let emptyNode = null;
    let lastTime = null;
    let lastDay = null; // 最近渲染消息所属日的 toDateString()
    let footerNode = null; // 钉在顶部的上滚分页状态行
    /** batchId -> { imagesEl, progressEl, textEl, expected, done } */
    const batches = new Map();
    /** 等待服务器权威 ts 的本端行（FIFO，见 bindServerTs） */
    const pendingOwn = [];
    /** 永远等不到 ack 的本端行不得吞掉后续的 ack */
    const PENDING_ACK_TTL_MS = 10_000;

    // ----- 回到底部胶囊（也统计落在视口下方的新消息数） -----
    let jumpPill = null;
    let newBelow = 0;

    function nearBottom() {
        return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }

    function scrollBottom() {
        container.scrollTop = container.scrollHeight;
    }

    function updateJumpPill() {
        if (nearBottom()) {
            newBelow = 0;
            if (jumpPill) jumpPill.classList.add('hidden');
            return;
        }
        if (!jumpPill) {
            jumpPill = el(
                'button',
                {
                    class: 'chat-jump hidden',
                    type: 'button',
                    onclick: () => {
                        scrollBottom();
                        updateJumpPill();
                    },
                },
                el('span', { class: 'chat-jump-label' })
            );
            // 输入区在 DOM 中紧跟列表——把胶囊挂在列表里
            // 使其始终锚定在输入框上方，与输入区高度无关
            (container.nextElementSibling || container.parentElement).append(jumpPill);
        }
        jumpPill.classList.remove('hidden');
        jumpPill.firstChild.textContent = newBelow > 0 ? jumpNewText(newBelow) : jumpText;
    }

    container.addEventListener('scroll', updateJumpPill, { passive: true });

    function showEmpty() {
        if (!emptyText || emptyNode) return;
        emptyNode = el('div', { class: 'chat-empty', text: emptyText });
        container.append(emptyNode);
    }

    function dayLabel(date) {
        const now = new Date();
        if (date.toDateString() === now.toDateString()) return todayText;
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return yesterdayText;
        if (dayText) return dayText(date);
        const y = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}-`;
        return `${y}${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function timeChipText(d) {
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return formatTime(d);
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `${yesterdayText} ${formatTime(d)}`;
        return d.getFullYear() === now.getFullYear() ? formatDate(d) : `${d.getFullYear()}/${formatDate(d)}`;
    }

    /**
     * 消息间的时间小片，日历日变化时升级为整日分隔
     * （此时无论间隔多近都插入）。
     */
    function maybeTimeChip(time, stick) {
        const day = time.toDateString();
        if (day !== lastDay) {
            append(el('div', { class: 'chat-time day', text: dayLabel(time) }), stick, true);
            lastDay = day;
            lastTime = time.getTime();
            return;
        }
        const ts = time.getTime();
        if (lastTime !== null && ts - lastTime <= TIME_GAP_MS) {
            lastTime = Math.max(lastTime, ts);
            return;
        }
        append(el('div', { class: 'chat-time', text: timeChipText(time) }), stick, true);
        lastTime = ts;
    }
    /**
     * @param {object} msg
     * @param {string} msg.name
     * @param {string} msg.text
     * @param {boolean} [msg.self]
     * @param {boolean} [msg.system]
     * @param {Date} [msg.time]
     * @param {object} [msg.reply] {name, text, ts} 被回复行的引用
     * @param {boolean} [msg.deleted] 渲染为撤回墓碑
     * @param {boolean} [msg.edited] 显示「（已编辑）」标记
     * @param {object|null} [msg.reactions] emoji -> [回应者昵称]
     */
    function add({
        name,
        text,
        self = false,
        system = false,
        time = new Date(),
        reply = null,
        deleted = false,
        edited = false,
        reactions = null,
        bindAck = true,
    }) {
        if (!text && !deleted) return;
        const stick = nearBottom();
        maybeTimeChip(new Date(time), stick);

        if (system) {
            append(el('div', { class: 'msg system' }, el('div', { class: 'msg-system-text', text })), stick);
            return;
        }
        const row = buildMessage({
            name,
            self,
            bubble: deleted ? tombstoneBubble() : textBubble(text, edited),
            ts: time.getTime(),
            reply,
            text: deleted ? '' : text,
            deleted,
            reactions,
        });
        append(row, stick);
        // 服务器分配权威 ts；chatAck 把它绑回刚渲染的行——历史
        // 渲染以 bindAck:false 绕过（其 ts 已是权威值）
        if (self && !deleted && bindAck) rememberPending(row);
    }

    /** 本地渲染的本端行入队，直到服务器的 chatAck 落地。 */
    function rememberPending(row) {
        if (!row || !row.dataset?.ts) return;
        pendingOwn.push({ row, at: Date.now() });
        if (pendingOwn.length > 20) pendingOwn.shift();
    }

    /**
     * 把服务器分配的 ts 绑定到最老的仍在等待的本端行。
     * 每次 chatAck 都会调用；被频道切换移除的行会跳过。
     */
    function bindServerTs(ts) {
        const value = Number(ts);
        if (!Number.isFinite(value) || value <= 0) return;
        const now = Date.now();
        while (pendingOwn.length) {
            const { row, at } = pendingOwn.shift();
            if (!row.isConnected) continue;
            // 被服务器丢弃的消息（超频限制、载荷被拒）永远等不到
            // ack——让这种条目占着头部会把后续每个 ack 都交给
            // 错误的行，编辑/撤回就会命中无关的消息。
            // 让它过期，本次 ack 宁可不绑定。
            if (now - at > PENDING_ACK_TTL_MS) continue;
            row.dataset.ts = String(value);
            // 悬停按钮在点击闭包里捕获了旧 ts——重建它们，
            // 让编辑/撤回使用服务器侧身份
            refreshRowActions(row);
            return;
        }
    }

    /** 撤回消息的置灰正文。 */
    function tombstoneBubble() {
        return el(
            'div',
            { class: 'msg-bubble deleted' },
            el('div', { class: 'msg-text tombstone', text: deletedText })
        );
    }

    /**
     * 独立图片消息（非批次）。src 必须是校验过的 data:image/* URL。
     */
    function addImage({ name, src, self = false, alt = 'image', time = new Date() }) {
        if (!DATA_URL_RE.test(src)) return;
        const when = new Date(time);
        const stick = nearBottom();
        maybeTimeChip(when, stick);
        const bubble = el('div', { class: 'msg-bubble img' }, imageNode(src, alt));
        append(buildMessage({ name, self, bubble, ts: when.getTime() }), stick);
    }

    /**
     * 在实时会话开始前渲染服务器持久化的历史。各行保留原始
     * 发送时间（时间小片自然重建）；图片批次按实时合并气泡
     * 的样式渲染——data URL 由发送者持久化，
     * 在触碰 DOM 前在这里重新校验。
     * @param {Array<{name:string,text:string,imgs?:string[],self?:boolean,time:Date}>} messages
     * @param {object} [options]
     * @param {string} [options.dividerText] 块之后显示的系统行
     * @param {string} [options.imageAlt]    持久化图片的 alt/title
     */
    function addHistory(messages, { dividerText = '', imageAlt = 'image' } = {}) {
        let shown = 0;
        for (const msg of Array.isArray(messages) ? messages : []) {
            if (!msg || typeof msg !== 'object') continue;
            const time = msg.time instanceof Date && !isNaN(msg.time) ? msg.time : new Date();
            const text = typeof msg.text === 'string' ? msg.text : '';
            const images = validImages(msg.imgs);
            if (!text && !images.length && !msg.deleted) continue;

            if (images.length) {
                const stick = nearBottom();
                maybeTimeChip(time, stick);
                const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(images.length, 6))}` });
                for (const src of images) imagesEl.append(imageNode(src, imageAlt));
                const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
                if (text) bubble.append(textNode(text, !!msg.edited));
                append(
                    buildMessage({
                        name: msg.name,
                        self: !!msg.self,
                        bubble,
                        ts: time.getTime(),
                        reply: validReply(msg.reply),
                        text,
                        deleted: !!msg.deleted,
                        reactions: validReactions(msg.reactions),
                    }),
                    stick
                );
            } else {
                add({
                    name: msg.name,
                    text,
                    self: !!msg.self,
                    time,
                    reply: validReply(msg.reply),
                    deleted: !!msg.deleted,
                    edited: !!msg.edited,
                    reactions: validReactions(msg.reactions),
                    // 历史行的 ts 已是服务器权威值，不得进 ack 队列
                    bindAck: false,
                });
            }
            shown++;
        }
        if (shown && dividerText) add({ text: dividerText, system: true });
    }

    /** 文本节点/气泡（含 @提及高亮）——渲染器在 chatShared */
    const { textBubble, textNode } = createTextRenderers({ getNames: mentionNames, getMe: selfName, editedText });

    function timeChipNode(time) {
        return el('div', { class: 'chat-time', text: timeChipText(time) });
    }

    /**
     * 在列表现有内容之上渲染更旧的一页持久化历史（上滚分页）。
     * 行规则与 addHistory 相同；本块的时间小片按块重建
     * （首行必带一片），并与既有顶部缝合：新行若已落入
     * 顶部小片的间隔阈值之内，该片变得冗余、被丢弃；
     * 跨越阈值的间隔保留它——DOM 上限裁掉过时则补一片。
     * 视口保持锚定：滚动偏移按插入高度增长，
     * 什么都不跳。
     * 刻意不执行 DOM 上限——刚取回的行绝不能
     * 又被裁掉。
     * @param {Array<{name:string,text:string,imgs?:string[],self?:boolean,time:Date}>} messages
     * @param {object} [options]
     * @param {string} [options.imageAlt] 持久化图片的 alt/title
     */
    function prependHistory(messages, { imageAlt = 'image' } = {}) {
        const frag = document.createDocumentFragment();
        let prevTs = null;
        let prevDay = null;
        let shown = 0;
        for (const msg of Array.isArray(messages) ? messages : []) {
            if (!msg || typeof msg !== 'object') continue;
            const time = msg.time instanceof Date && !isNaN(msg.time) ? msg.time : new Date();
            const ts = time.getTime();
            const day = time.toDateString();
            const text = typeof msg.text === 'string' ? msg.text : '';
            const images = validImages(msg.imgs);
            if (!text && !images.length && !msg.deleted) continue;

            if (prevDay !== day) {
                frag.append(el('div', { class: 'chat-time day', text: dayLabel(time) }));
                prevDay = day;
            } else if (prevTs === null || ts - prevTs > TIME_GAP_MS) {
                frag.append(timeChipNode(time));
            }
            let bubble;
            if (msg.deleted) {
                bubble = tombstoneBubble();
            } else if (images.length) {
                const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(images.length, 6))}` });
                for (const src of images) imagesEl.append(imageNode(src, imageAlt));
                bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
                if (text) bubble.append(textNode(text, !!msg.edited));
            } else {
                bubble = textBubble(text, !!msg.edited);
            }
            frag.append(
                buildMessage({
                    name: msg.name,
                    self: !!msg.self,
                    bubble,
                    ts,
                    reply: validReply(msg.reply),
                    text: msg.deleted ? '' : text,
                    deleted: !!msg.deleted,
                    reactions: validReactions(msg.reactions),
                })
            );
            prevTs = ts;
            shown++;
        }
        if (!shown) return;

        // 本块落在分页页脚（若在显示）之下、
        // 其余一切之上
        let anchor = container.firstChild;
        if (anchor?.classList?.contains('history-footer')) anchor = anchor.nextSibling;

        // 把边界缝合到块下方现在的第一行
        let topChip = null;
        let topRow = null;
        for (let n = anchor; n; n = n.nextSibling) {
            if (!n.classList) continue;
            if (!topChip && n.classList.contains('chat-time')) topChip = n;
            else if (n.classList.contains('msg')) {
                topRow = n;
                break;
            }
        }
        if (topRow?.dataset?.ts) {
            const topDate = new Date(Number(topRow.dataset.ts));
            const newDay = topDate.toDateString() !== prevDay;
            const gap = Number(topRow.dataset.ts) - prevTs;
            if (newDay) {
                // 日历日边界总是分隔——以日分隔线形式
                if (topChip) topChip.replaceWith(el('div', { class: 'chat-time day', text: dayLabel(topDate) }));
                else frag.append(el('div', { class: 'chat-time day', text: dayLabel(topDate) }));
            } else if (gap > TIME_GAP_MS) {
                if (!topChip) frag.append(timeChipNode(topDate));
                // 否则既有小片已分隔两块
            } else if (topChip) {
                // 边界小片自身可能就是插入锚点（列表的首个子节点）
                // ——丢弃前先重指锚点
                if (topChip === anchor) anchor = topChip.nextSibling;
                topChip.remove();
            }
        }

        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        const prevTop = container.scrollTop;
        const prevHeight = container.scrollHeight;
        container.insertBefore(frag, anchor ?? null);
        container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
    }

    /**
     * 钉在列表最顶端的分页状态行：
     * 页面在途中为 'loading'，存储取空后为 'end'，
     * null 为清除。
     */
    function setHistoryFooter(state) {
        if (footerNode) {
            footerNode.remove();
            footerNode = null;
        }
        const text = state === 'loading' ? historyLoadingText : state === 'end' ? historyEndText : '';
        if (!text) return;
        footerNode = el('div', { class: 'msg system history-footer' }, el('div', { class: 'msg-system-text', text }));
        container.prepend(footerNode);
    }

    /**
     * 为一次发送的文本 + N 张图片打开合并气泡（QQ 风格：
     * 图片叠在气泡内，文本在下）。图片在各自传输完成后
     * 经 addBatchImage 追加。
     * @param {object} msg
     * @param {string}  msg.batch  与图片帧共享的批次 id
     * @param {string}  msg.name
     * @param {string}  [msg.text]
     * @param {number}  msg.count  预告的图片数
     * @param {boolean} [msg.self]
     * @param {Date}    [msg.time]
     */
    function openBatch({ batch, name, text = '', count = 1, self = false, time = new Date(), reply = null }) {
        if (!batch) return;
        const when = new Date(time);
        const stick = nearBottom();
        maybeTimeChip(when, stick);

        const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(count, 6))}` });
        const progressEl = el('div', { class: 'msg-img-progress', text: imagesProgress(0, count) });
        const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
        if (text) bubble.append(textNode(text, false));
        bubble.append(progressEl);
        const row = buildMessage({ name, self, bubble, ts: when.getTime(), reply: validReply(reply), text });
        append(row, stick);
        if (self) rememberPending(row); // 批次存储后会有 chatAck

        batches.set(batch, {
            row: container.lastChild,
            imagesEl,
            progressEl,
            bubble,
            expected: count,
            done: 0,
            failed: 0,
        });
    }

    /**
     * 把一张到达的图片追加进其批次气泡。批次行已不在
     * （历史上限裁剪）时回退为独立图片消息。
     */
    function addBatchImage(batch, src, alt = 'image') {
        if (!DATA_URL_RE.test(src)) return failBatchImage(batch);
        const entry = batches.get(batch);
        if (!entry) return addImage({ name: '?', src, alt });
        entry.done++;
        entry.imagesEl.append(imageNode(src, alt));
        settleBatch(batch, entry);
    }

    /** 批次中一张图片传输失败。 */
    function failBatchImage(batch) {
        const entry = batches.get(batch);
        if (!entry) return;
        entry.failed++;
        settleBatch(batch, entry);
    }

    function settleBatch(batch, entry) {
        const stick = nearBottom();
        const settled = entry.done + entry.failed >= entry.expected;
        if (settled) {
            if (entry.failed && entry.done) {
                entry.progressEl.textContent = imagesProgress(entry.done, entry.expected);
            } else if (entry.failed && !entry.done) {
                if (!entry.bubble.querySelector('.msg-text')) {
                    entry.bubble.append(el('div', { class: 'msg-text', text: failText }));
                }
                entry.progressEl.remove();
            } else {
                entry.progressEl.remove();
            }
            batches.delete(batch);
            if (stick) scrollBottom();
            return;
        }
        entry.progressEl.textContent = imagesProgress(entry.done, entry.expected);
    }

    function imageNode(src, alt) {
        const img = el('img', {
            class: 'msg-image',
            alt,
            loading: 'lazy',
            title: alt,
        });
        img.src = src;
        img.addEventListener('click', () => openLightbox(img.src, alt));
        return img;
    }

    /** 按 ts + 发送者名（消息身份）查找已渲染的行。 */
    function findRow(name, ts) {
        if (!name || !Number.isFinite(ts)) return null;
        for (const child of [...container.children].reverse()) {
            if (child.classList?.contains('msg') && child.dataset?.ts === String(ts) && child.dataset?.name === name) {
                return child;
            }
        }
        return null;
    }

    // ----- 实时消息生命周期（服务器广播的结果） -----

    /** 应用编辑广播：新文本 + 已编辑标记。 */
    function editMessage({ name, ts, text }) {
        const row = findRow(name, ts);
        if (!row || typeof text !== 'string') return;
        row._deleted = false;
        row.dataset.text = text;
        const bubble = row.querySelector('.msg-bubble');
        if (!bubble) return;
        const quote = row.querySelector('.msg-quote');
        const imgs = row.querySelector('.msg-images');
        // 编辑过的行带「（已编辑）」标记——总是回到普通气泡，
        // 绝不用超大 emoji 样式
        bubble.classList.remove('emoji-only');
        bubble.replaceChildren();
        if (quote) bubble.append(quote);
        if (imgs) bubble.append(imgs);
        bubble.append(textNode(text, true));
        refreshRowActions(row);
    }

    /** 应用撤回广播：该行变为墓碑。 */
    function deleteMessage({ name, ts }) {
        const row = findRow(name, ts);
        if (!row) return;
        row._deleted = true;
        row.dataset.text = '';
        row.classList.add('recalled');
        const bubble = row.querySelector('.msg-bubble');
        if (bubble) {
            // 墓碑不得继承超大 emoji 尺寸
            bubble.classList.remove('emoji-only');
            bubble.replaceChildren(el('div', { class: 'msg-text tombstone', text: deletedText }));
        }
        row.querySelector('.msg-reactions')?.remove();
        row.querySelector('.msg-actions')?.remove();
    }

    /** 应用回应广播：从映射重建回应条。 */
    function reactMessage({ name, ts, reactions }) {
        const row = findRow(name, ts);
        if (!row || row._deleted) return;
        row.querySelector('.msg-reactions')?.remove();
        const map = validReactions(reactions);
        row._reactions = map || undefined;
        if (!map) return;
        row.querySelector('.msg-body')?.append(reactionsNode(row, map));
    }

    /** 气泡下方的回应 chip；点击切换本地用户的参与状态。 */
    function reactionsNode(row, map) {
        const me = selfName();
        const wrap = el('div', { class: 'msg-reactions' });
        for (const [emoji, names] of Object.entries(map)) {
            const mine = names.includes(me);
            const chip = el(
                'button',
                {
                    class: 'msg-reaction' + (mine ? ' mine' : ''),
                    type: 'button',
                    title: names.slice(0, 6).join(', '),
                },
                emoji,
                names.length > 1 ? el('span', { class: 'msg-reaction-count', text: String(names.length) }) : null
            );
            chip.addEventListener('click', (event) => {
                event.stopPropagation();
                onReact?.({ name: row.dataset.name, ts: Number(row.dataset.ts), emoji, on: !mine });
            });
            wrap.append(chip);
        }
        return wrap;
    }

    /** 状态变化后重建一行的悬停操作按钮。 */
    function refreshRowActions(row) {
        row.querySelector('.msg-actions')?.remove();
        const actions = rowActionsNode(row);
        if (actions) row.append(actions);
    }

    /** 悬停操作簇：回复 / 回应 / 编辑 / 撤回。 */
    function rowActionsNode(row) {
        if (!onReply && !onReact && !onEdit && !onDelete) return null;
        const name = row.dataset.name || '?';
        const ts = Number(row.dataset.ts) || 0;
        const mine = name === selfName();
        const host = isHost();
        const buttons = [];
        if (onReply) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn',
                        type: 'button',
                        'aria-label': 'reply',
                        title: 'reply',
                        onclick: (event) => {
                            event.stopPropagation();
                            onReply({ name, text: row.dataset.text || '', ts });
                        },
                    },
                    '↩'
                )
            );
        }
        if (onReact && !row._deleted) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn',
                        type: 'button',
                        'aria-label': 'react',
                        title: 'react',
                        onclick: (event) => {
                            event.stopPropagation();
                            openEmojiPicker(event.currentTarget, (emoji) =>
                                onReact({ name, ts, emoji, on: !(row._reactions?.[emoji] || []).includes(selfName()) })
                            );
                        },
                    },
                    '😊'
                )
            );
        }
        if (onEdit && mine && !row._deleted && row.dataset.text) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn',
                        type: 'button',
                        'aria-label': 'edit',
                        title: 'edit',
                        onclick: (event) => {
                            event.stopPropagation();
                            onEdit({ name, text: row.dataset.text, ts });
                        },
                    },
                    '✎'
                )
            );
        }
        if (onDelete && !row._deleted && (mine || host)) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn danger',
                        type: 'button',
                        'aria-label': 'recall',
                        title: 'recall',
                        onclick: (event) => {
                            event.stopPropagation();
                            onDelete({ name, ts });
                        },
                    },
                    '🗑'
                )
            );
        }
        if (!buttons.length) return null;
        return el('div', { class: 'msg-actions' }, ...buttons);
    }

    /** 一行 QQ 风格消息：头像贴着 [昵称] + 气泡的主体。
     *  两侧的 DOM 顺序都是 [avatar, body]——.msg.self 的
     *  flex-direction: row-reverse 将其翻转，头像落在右缘、
     *  气泡在其左。`ts` 标记该行，供上滚分页把时间小片
     *  缝合到既有顶部。
     *  回复引用（若有）位于气泡顶部，悬停按钮提供
     *  回复/回应/编辑/撤回，行带回应时气泡下方
     *  渲染回应条。 */
    function buildMessage({ name, self, bubble, ts, reply = null, text = '', deleted = false, reactions = null }) {
        const row = el('div', {
            class: 'msg' + (self ? ' self' : '') + (deleted ? ' recalled' : ''),
            dataset: { name: name || '?', ...(ts ? { ts: String(ts) } : {}), ...(text ? { text } : {}) },
        });
        row._deleted = deleted;
        row._reactions = reactions || undefined;
        if (reply) {
            bubble.prepend(quoteNode(reply));
            // 带引用回复的气泡保持普通外观——超大字形会
            // 碾压引用、让它失去容器漂浮
            bubble.classList.remove('emoji-only');
        }
        const body = el('div', { class: 'msg-body' });
        if (!self && name) body.append(el('div', { class: 'msg-name', text: name }));
        body.append(bubble);
        if (reactions) body.append(reactionsNode(row, reactions));
        row.append(avatarNode(name), body);
        const actions = rowActionsNode(row);
        if (actions) row.append(actions);
        return row;
    }

    /** 回复气泡内的引用行——点击滚动到原消息。 */
    function quoteNode(reply) {
        const node = el(
            'div',
            { class: 'msg-quote' },
            el('span', { class: 'msg-quote-name', text: reply.name || '?' }),
            el('span', { class: 'msg-quote-text', text: reply.text || '' })
        );
        if (reply.ts) {
            node.addEventListener('click', () => {
                const target = findRow(reply.name, reply.ts);
                if (!target) return;
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                target.classList.add('flash');
                setTimeout(() => target.classList.remove('flash'), 1200);
            });
        }
        return node;
    }

    function avatarNode(name) {
        return buildAvatarNode(name, avatarFor ? avatarFor(name) : '', 'msg-avatar');
    }

    /**
     * 自定义头像变更（自己或某 peer）——重渲染匹配行的头像，
     * 让历史跟随更新，与 QQ 一致。
     */
    function setAvatar(name, url) {
        if (!name) return;
        for (const row of [...container.children]) {
            if (row.classList?.contains('msg') && row.dataset.name === name) {
                row.querySelector('.msg-avatar')?.replaceWith(avatarNode(name));
            }
        }
    }

    /** 某 peer 改名——其行的后续头像更新改指向新名。 */
    function renamePeer(oldName, newName) {
        if (!oldName || !newName || oldName === newName) return;
        for (const row of container.children) {
            if (row.dataset?.name === oldName) row.dataset.name = newName;
        }
    }

    // ----- 对已渲染行的客户端搜索（仅已加载页） -----

    /**
     * 按查询串过滤已渲染列表（匹配发送者名与文本）。
     * '' / null 清除过滤。返回 { total, hits } 供调用方
     * 计数，清除过滤时返回 null。
     */
    function setSearch(query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) {
            container.classList.remove('searching');
            for (const child of container.children) child.classList.remove('hit', 'miss');
            return null;
        }
        container.classList.add('searching');
        let total = 0;
        let hits = 0;
        for (const child of container.children) {
            if (!child.classList?.contains('msg') || child.classList.contains('system')) {
                child.classList.add('miss');
                child.classList.remove('hit');
                continue;
            }
            total++;
            const name = (child.dataset?.name || '').toLowerCase();
            const text = (child.dataset?.text || '').toLowerCase();
            const match = name.includes(q) || text.includes(q);
            child.classList.toggle('hit', match);
            child.classList.toggle('miss', !match);
            if (match) hits++;
        }
        return { total, hits };
    }

    function append(node, stick, isChip = false) {
        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        container.append(node);
        if (stick) scrollBottom();
        else if (!isChip && node.classList?.contains('msg')) newBelow = newBelow + 1;
        // 裁剪历史，长时间会话也不能让 DOM 无界增长
        while (container.children.length > 300) {
            const removed = container.firstChild;
            // 被裁掉的批次行无法再接收图片——删除其条目，
            // 迟到的分块回退为独立图片消息
            for (const [id, entry] of batches) {
                if (entry.row === removed) batches.delete(id);
            }
            removed.remove();
        }
        if (!container.children.length) showEmpty();
        updateJumpPill(); // 无需滚动事件即可显隐胶囊
    }

    // ----- 灯箱（点击图片全尺寸查看，实现在 chatShared） -----

    const lightbox = createLightbox(downloadText);
    function openLightbox(src, alt) {
        lightbox.open(src, alt);
    }

    showEmpty();
    return {
        add,
        addHistory,
        prependHistory,
        setHistoryFooter,
        addImage,
        openBatch,
        addBatchImage,
        failBatchImage,
        setAvatar,
        renamePeer,
        editMessage,
        deleteMessage,
        reactMessage,
        bindServerTs,
        setSearch,
    };
}
