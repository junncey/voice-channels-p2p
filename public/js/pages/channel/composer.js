/*
聊天输入区 —— 频道页文字聊天的输入侧：
回复与编辑输入态、正在输入指示（DataChannel 广播，
完全不碰服务器）、@提及自动补全、QQ 式发送键偏好、
消息提交（纯文字 / 文字+图片批次）及其发往历史存储的
中转副本、待发图片托盘，
以及对已渲染行的搜索过滤。
共享页面状态经 `s` 存取器对象到达，跨模块调用走晚绑定的
`x` 调用面（两者都归 channel.js 所有）。
*/

export function createComposer({
    s,
    x,
    members,
    channelId,
    openEmojiPicker,
    fileToImageMessage,
    sendImageData,
    MAX_FILE_BYTES,
    toast,
    t,
    $,
    el,
}) {
    const SEND_KEY_STORE = 'vc_send_key'; // 'enter' (default) | 'ctrlEnter'
    // 输入区发送键偏好（QQ 式）：Enter 或 Ctrl+Enter 发送，
    // 其余组合插入换行
    let sendKey = localStorage.getItem(SEND_KEY_STORE) === 'ctrlEnter' ? 'ctrlEnter' : 'enter';

    // ----- 回复输入态 -----

    let replyTo = null; // 被回复行的 {name, text, ts}

    function startReply({ name, text, ts }) {
        replyTo = { name: name || '?', text: (text || t('chat.image')).slice(0, 80), ts: ts || 0 };
        $('#replyBar').classList.remove('hidden');
        $('#replyPreview').replaceChildren(
            el('span', { class: 'reply-label', text: t('chat.replyTo', { name: replyTo.name }) }),
            el('span', { class: 'reply-text', text: replyTo.text })
        );
        $('#chatInput').focus();
    }

    function cancelReply() {
        replyTo = null;
        $('#replyBar').classList.add('hidden');
    }

    /** 外发消息/历史事件的载荷；不在回复态时为 null。 */
    function replyPayload() {
        if (!replyTo) return null;
        return { name: replyTo.name, text: replyTo.text.slice(0, 80), ts: replyTo.ts };
    }

    // ----- 编辑输入态（编辑自己已发出的纯文字消息） -----

    let editing = null; // 被编辑行的 {name, ts}

    function startEdit({ name, text, ts }) {
        cancelReply();
        editing = { name, ts };
        const input = $('#chatInput');
        input.value = text;
        autoGrowChatInput();
        $('#editBar').classList.remove('hidden');
        $('#editPreview').replaceChildren(
            el('span', { class: 'reply-label', text: t('chat.editing') }),
            el('span', { class: 'reply-text', text: text.slice(0, 60) })
        );
        input.focus();
    }

    function cancelEdit() {
        if (!editing) return;
        editing = null;
        $('#editBar').classList.add('hidden');
        const input = $('#chatInput');
        input.value = '';
        autoGrowChatInput();
        input.focus();
    }

    // ----- 正在输入指示（DataChannel 广播，完全不碰服务器） -----

    const TYPING_SEND_MS = 3000; // 输入中的重复播报节奏
    const TYPING_TIMEOUT_MS = 6000; // 视为对端已停止输入的静默时长
    let typingSentAt = 0;
    const typingPeers = new Map(); // 显示名 -> 到期定时器

    function maybeSendTyping() {
        if (!s.joined || !s.mesh) return;
        const now = Date.now();
        if (now - typingSentAt < TYPING_SEND_MS) return;
        typingSentAt = now;
        s.mesh.sendChat({ type: 'typing', from: s.selfName });
    }

    function notePeerTyping(name) {
        if (!name || name === s.selfName) return;
        clearTimeout(typingPeers.get(name));
        typingPeers.set(
            name,
            setTimeout(() => {
                typingPeers.delete(name);
                renderTyping();
            }, TYPING_TIMEOUT_MS)
        );
        renderTyping();
    }

    function renderTyping() {
        const bar = $('#typingBar');
        const names = [...typingPeers.keys()];
        if (!names.length) {
            bar.classList.add('hidden');
            return;
        }
        const label =
            names.length === 1
                ? t('chat.typing', { name: names[0] })
                : names.length === 2
                  ? t('chat.typingTwo', { a: names[0], b: names[1] })
                  : t('chat.typingMany', { n: names.length });
        $('#typingText').textContent = label;
        bar.classList.remove('hidden');
    }

    function clearTyping() {
        for (const timer of typingPeers.values()) clearTimeout(timer);
        typingPeers.clear();
        renderTyping();
    }

    // ----- @提及自动补全（输入区上方的菜单） -----

    let mention = null; // { items, index, at } —— at = 输入框中 '@' 的位置

    function memberNamesForMention() {
        return [
            ...new Set(
                [...members.values()]
                    .filter((m) => !m.self)
                    .map((m) => m.peer_name)
                    .filter(Boolean)
            ),
        ];
    }

    function updateMentionMenu() {
        const input = $('#chatInput');
        if (!s.joined || document.activeElement !== input) return closeMentionMenu();
        const caret = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, caret);
        const m = before.match(/(?:^|\s)@([^\s@]{0,24})$/);
        if (!m) return closeMentionMenu();
        const at = caret - m[1].length - 1; // '@' 的位置
        const frag = m[1].toLowerCase();
        const items = memberNamesForMention()
            .filter((name) => name.toLowerCase().startsWith(frag))
            .slice(0, 6);
        if (!items.length) return closeMentionMenu();
        mention = { items, index: 0, at };

        const menu = $('#mentionMenu');
        menu.replaceChildren(
            ...items.map((name, i) =>
                el(
                    'button',
                    {
                        type: 'button',
                        class: 'mention-item' + (i === 0 ? ' active' : ''),
                        onclick: () => completeMention(name),
                    },
                    el('span', { class: 'mention-at', text: '@' }),
                    name
                )
            )
        );
        menu.classList.remove('hidden');
    }

    function closeMentionMenu() {
        mention = null;
        $('#mentionMenu').classList.add('hidden');
    }

    function completeMention(name) {
        const input = $('#chatInput');
        if (!mention) return;
        input.setRangeText(`@${name} `, mention.at, input.selectionStart ?? mention.at, 'end');
        closeMentionMenu();
        input.focus();
        autoGrowChatInput();
    }

    /** 提及菜单打开时的按键处理；消费了按键则返回 true。 */
    function mentionMenuKeydown(event) {
        if (!mention) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            mention.index =
                (mention.index + (event.key === 'ArrowDown' ? 1 : mention.items.length - 1)) % mention.items.length;
            [...$('#mentionMenu').children].forEach((child, i) =>
                child.classList.toggle('active', i === mention.index)
            );
            return true;
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey)) {
            event.preventDefault();
            completeMention(mention.items[mention.index]);
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMentionMenu();
            return true;
        }
        return false;
    }

    // ----- 输入区事件接线 -----

    // 输入区 textarea 随内容长高到该高度为止，之后滚动
    const CHAT_INPUT_MAX_HEIGHT = 120;

    function bindChatInput() {
        const input = $('#chatInput');
        input.addEventListener('input', () => {
            autoGrowChatInput();
            updateMentionMenu();
            if (input.value.trim()) maybeSendTyping();
        });
        input.addEventListener('keydown', onChatInputKeydown);
        $('#replyCancelBtn').addEventListener('click', cancelReply);
        $('#editCancelBtn').addEventListener('click', cancelEdit);

        // 输入区 emoji：经共享调色板在光标处插入
        $('#emojiBtn').addEventListener('click', (event) => {
            openEmojiPicker(event.currentTarget, (emoji) => {
                const box = $('#chatInput');
                const at = box.selectionStart ?? box.value.length;
                const end = box.selectionEnd ?? at;
                box.setRangeText(emoji, at, end, 'end');
                box.focus();
                autoGrowChatInput();
            });
        });

        // 发送按钮旁箭头按钮展开的 QQ 式发送键菜单
        const menu = $('#sendKeyMenu');
        const caret = $('#sendKeyBtn');
        for (const radio of menu.querySelectorAll('input[name="sendKey"]')) {
            if (radio.value === sendKey) radio.checked = true;
            radio.addEventListener('change', () => {
                sendKey = radio.value === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
                localStorage.setItem(SEND_KEY_STORE, sendKey);
                toggleSendKeyMenu(false);
            });
        }
        caret.addEventListener('click', () => toggleSendKeyMenu(menu.classList.contains('hidden')));
        document.addEventListener('click', (event) => {
            if (!menu.classList.contains('hidden') && !menu.contains(event.target) && !caret.contains(event.target)) {
                toggleSendKeyMenu(false);
            }
            // 提及菜单只在外部点击时关闭 —— 点它自己的按钮
            // 是完成补全
            const mMenu = $('#mentionMenu');
            if (!mMenu.classList.contains('hidden') && !mMenu.contains(event.target) && event.target !== input) {
                closeMentionMenu();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') toggleSendKeyMenu(false);
        });
    }

    function toggleSendKeyMenu(open) {
        $('#sendKeyMenu').classList.toggle('hidden', !open);
        $('#sendKeyBtn').classList.toggle('open', open);
    }

    function autoGrowChatInput() {
        const input = $('#chatInput');
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, CHAT_INPUT_MAX_HEIGHT) + 'px';
    }

    function onChatInputKeydown(event) {
        // 提及菜单打开时，其导航优先于一切其他按键行为
        if (mentionMenuKeydown(event)) return;
        // Esc 退出回复/编辑输入态（发送键菜单在下方处理）
        if (event.key === 'Escape') {
            if (editing) cancelEdit();
            else if (replyTo) cancelReply();
        }
        // IME 组合输入期间：Enter 是确认候选词，绝不能当作发送
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key !== 'Enter') return;
        // 换行/发送必须显式处理 —— 依赖浏览器默认插入行为
        // 在各种 webview 与移动键盘上并不可靠
        event.preventDefault();
        const ctrlEnter = event.ctrlKey || event.metaKey;
        if (sendKey === 'enter') {
            if (ctrlEnter || event.shiftKey) insertChatNewline();
            else $('#chatForm').requestSubmit();
        } else if (ctrlEnter) {
            $('#chatForm').requestSubmit();
        } else {
            insertChatNewline();
        }
    }

    function insertChatNewline() {
        const input = $('#chatInput');
        // execCommand 能保留原生撤销栈；setRangeText 是回退
        let inserted = false;
        try {
            inserted = document.execCommand('insertText', false, '\n');
        } catch {
            /* execCommand 不可用 —— 走下方 setRangeText 回退 */
        }
        if (!inserted) input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        autoGrowChatInput();
    }

    /**
     * 把外发聊天消息的副本交给服务器存入历史存储。
     * 实时送达仍走 DataChannel mesh 的 P2P；这份中转只为存储
     * （发送端是唯一上报点，不会重复入库）。带图片的提交 =
     * 1 个 head 事件 + 每图 1 个事件 —— 每张图独占一个事件，
     * 因为整批可能超出 socket.io 单包上限；服务器会把这批
     * 组装成一条历史行。
     */
    function emitChatForHistory(text, images = [], reply = null) {
        if (!s.socket) return;
        const replyField = reply ? { reply } : {};
        if (!images.length) {
            s.socket.emit('chat', { room_id: channelId, msg: text, ...replyField });
            return;
        }
        const batch = crypto.randomUUID();
        s.socket.emit('chat', { room_id: channelId, msg: text, batch, imgs: images.length, ...replyField });
        for (const img of images) s.socket.emit('chat', { room_id: channelId, batch, img });
    }

    async function onChatSubmit(event) {
        event.preventDefault();
        if (!s.joined) return;
        const input = $('#chatInput');
        const text = input.value.trim().slice(0, 500);
        const images = [...pendingImages];

        // 编辑模式：重新提交自己已发出的行（仅文字；服务器把
        // 持久化结果广播给所有人，包括我们自己）
        if (editing) {
            if (text && s.socket) {
                s.socket.emit('chatEdit', { room_id: channelId, ts: editing.ts, name: editing.name, msg: text });
            }
            cancelEdit();
            return;
        }

        if (!text && !images.length) return;
        input.value = '';
        autoGrowChatInput();
        closeMentionMenu();
        clearPendingImages(); // 托盘提前清空；失败按图逐个 toast

        const reply = replyPayload();
        cancelReply();

        if (!images.length) {
            trySendChat({ type: 'chat', from: s.selfName, msg: text, reply });
            s.chat.add({ name: s.selfName, text, self: true, reply });
            emitChatForHistory(text, [], reply);
            return;
        }

        // 文字 + 图片作为一个批次发出 = 每个接收端合成一条气泡
        const payloads = [];
        for (const item of images) {
            try {
                payloads.push(await fileToImageMessage(item.file));
            } catch (err) {
                const key = err?.message === 'too-large' ? 'chat.imageTooLarge' : 'chat.imageUnsupported';
                toast(t(key), 'warn');
            }
        }
        if (!payloads.length) {
            if (text) {
                trySendChat({ type: 'chat', from: s.selfName, msg: text, reply });
                s.chat.add({ name: s.selfName, text, self: true, reply });
                emitChatForHistory(text, [], reply);
            }
            return;
        }

        const batch = crypto.randomUUID();
        if (!trySendChat({ type: 'chat', from: s.selfName, msg: text, batch, imgs: payloads.length, reply })) return;
        s.chat.openBatch({ batch, name: s.selfName, text, count: payloads.length, self: true, reply });
        emitChatForHistory(
            text,
            payloads.map((payload) => payload.dataUrl),
            reply
        );
        for (const payload of payloads) {
            try {
                await sendImageData({
                    send: (frame) => s.mesh.sendChat(frame),
                    // 背压：按 SCTP 缓冲节奏发块，避免突发把共用
                    // 链路的语音包饿死
                    ready: () => s.mesh?.drainChat?.(),
                    from: s.selfName,
                    mime: payload.mime,
                    dataUrl: payload.dataUrl,
                    batch,
                });
            } catch {
                // 某 DataChannel 拒收了帧（发送缓冲满 / 通道正在
                // 关闭 / 队列超预算）—— 在此停住，而不是悄悄
                // 丢掉批次里剩下的图片
                toast(t('chat.imageSendFailed'), 'warn');
                break;
            }
            s.chat.addBatchImage(batch, payload.dataUrl, t('chat.image'));
        }
    }

    /**
     * 带送达失败路径的 mesh.sendChat：DataChannel 拒收帧
     * （缓冲满 / 正在关闭）绝不能以未捕获异常的形式冒出来。
     * 无法送达时先 toast 再返回 false。
     */
    function trySendChat(payload) {
        try {
            s.mesh.sendChat(payload);
            return true;
        } catch {
            toast(t('chat.sendFailed'), 'warn');
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // 聊天搜索 —— 过滤的是已渲染行（只搜已加载页，不请求服务器）；
    // 计数器显示已加载消息中的命中数
    // -------------------------------------------------------------------------

    function bindChatSearch() {
        const btn = $('#chatSearchBtn');
        const input = $('#chatSearchInput');
        const count = $('#chatSearchCount');
        let open = false;

        const close = () => {
            open = false;
            btn.classList.remove('active');
            input.classList.add('hidden');
            count.classList.add('hidden');
            input.value = '';
            s.chat?.setSearch('');
        };
        btn.addEventListener('click', () => {
            if (open) return close();
            open = true;
            btn.classList.add('active');
            input.classList.remove('hidden');
            input.focus();
        });
        input.addEventListener('input', () => {
            const result = s.chat?.setSearch(input.value);
            if (result) {
                count.classList.remove('hidden');
                count.textContent = t('chat.searchCount', { hits: result.hits, total: result.total });
            } else {
                count.classList.add('hidden');
            }
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
            }
        });
    }

    // -------------------------------------------------------------------------
    // 待发图片托盘（输入区附件）
    // -------------------------------------------------------------------------

    function bindImageUi() {
        $('#imageBtn').addEventListener('click', () => $('#imageFileInput').click());
        $('#imageFileInput').addEventListener('change', (event) => {
            const files = [...(event.target.files || [])];
            event.target.value = ''; // 允许再次选择同一个文件
            for (const file of files) addPendingImage(file);
        });

        // 粘贴的图片进输入区托盘，随后还能继续补文字或图片，
        // 最后一起发出
        window.addEventListener('paste', (event) => {
            if (!s.joined) return;
            const items = event.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                        event.preventDefault();
                        addPendingImage(file);
                        return;
                    }
                }
            }
        });
    }

    const MAX_PENDING_IMAGES = 6;
    let pendingImages = []; // {id, file, url}
    let pendingImageSeq = 0;

    function addPendingImage(file) {
        if (!s.joined) return;
        if (!file || !file.type.startsWith('image/')) return toast(t('chat.imageUnsupported'), 'warn');
        if (file.size > 8 * 1024 * 1024) return toast(t('chat.imageTooLarge'), 'warn');
        if (pendingImages.length >= MAX_PENDING_IMAGES) return toast(t('chat.imageTooMany'), 'warn');
        pendingImages.push({ id: ++pendingImageSeq, file, url: URL.createObjectURL(file) });
        renderPendingImages();
    }

    function removePendingImage(id) {
        const index = pendingImages.findIndex((item) => item.id === id);
        if (index === -1) return;
        URL.revokeObjectURL(pendingImages[index].url);
        pendingImages.splice(index, 1);
        renderPendingImages();
    }

    function clearPendingImages() {
        for (const item of pendingImages) URL.revokeObjectURL(item.url);
        pendingImages = [];
        renderPendingImages();
    }

    function renderPendingImages() {
        const tray = $('#chatAttachments');
        tray.replaceChildren(
            ...pendingImages.map((item) =>
                el(
                    'div',
                    { class: 'chat-attachment' },
                    el('img', { src: item.url, alt: t('chat.image') }),
                    el('button', {
                        class: 'chat-attachment-remove',
                        type: 'button',
                        text: '✕',
                        'aria-label': 'remove image',
                        onclick: () => removePendingImage(item.id),
                    })
                )
            )
        );
        tray.classList.toggle('hidden', !pendingImages.length);
    }

    return {
        startReply,
        startEdit,
        notePeerTyping,
        clearTyping,
        bindChatInput,
        bindChatSearch,
        bindImageUi,
        onChatSubmit,
        clearPendingImages,
    };
}
