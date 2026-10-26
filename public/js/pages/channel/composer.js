/*
Chat composer — the input side of the channel page's text chat: reply and
edit composers, the typing indicator (DataChannel broadcast, nothing
touches the server), @mention autocomplete, the QQ-style send-key
preference, message submit (text / text+images batches) with the
history-store relay copy, the pending-image tray and the rendered-rows
search filter.
Shared page state arrives via the `s` accessor object, cross-module calls
via the late-bound `x` surface (both owned by channel.js).
*/

export function createComposer({
    s,
    x,
    members,
    channelId,
    openEmojiPicker,
    fileToImageMessage,
    sendImageData,
    toast,
    t,
    $,
    el,
}) {
    const SEND_KEY_STORE = 'vc_send_key'; // 'enter' (default) | 'ctrlEnter'
    // composer send key preference (QQ style): Enter or Ctrl+Enter sends, the
    // other combinations insert a newline
    let sendKey = localStorage.getItem(SEND_KEY_STORE) === 'ctrlEnter' ? 'ctrlEnter' : 'enter';

    // ----- reply composer -----

    let replyTo = null; // {name, text, ts} of the row being answered

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

    /** Payload for the outgoing message/history event; null when not replying. */
    function replyPayload() {
        if (!replyTo) return null;
        return { name: replyTo.name, text: replyTo.text.slice(0, 80), ts: replyTo.ts };
    }

    // ----- edit composer (one's own already-sent text message) -----

    let editing = null; // {name, ts} of the row being edited

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

    // ----- typing indicator (DataChannel broadcast, nothing touches the server) -----

    const TYPING_SEND_MS = 3000; // re-announce cadence while composing
    const TYPING_TIMEOUT_MS = 6000; // peer silence assumption
    let typingSentAt = 0;
    const typingPeers = new Map(); // display name -> expiry timer

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

    // ----- @mention autocomplete (menu above the composer) -----

    let mention = null; // { items, index, at } — at = index of the '@' in the input

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
        const at = caret - m[1].length - 1; // position of the '@'
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

    /** Key handling while the mention menu is open; returns true when consumed. */
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

    // ----- composer input wiring -----

    // composer textarea grows with the content up to this height, then scrolls
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

        // composer emoji: insert at the caret via the shared palette
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

        // QQ-style send-key menu behind the caret next to the send button
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
            // the mention menu only closes on outside clicks — its own buttons
            // complete the mention instead
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
        // mention menu navigation wins over everything else while it is open
        if (mentionMenuKeydown(event)) return;
        // Esc bails out of the reply/edit composers (sendKey menu handled below)
        if (event.key === 'Escape') {
            if (editing) cancelEdit();
            else if (replyTo) cancelReply();
        }
        // IME composition: Enter confirms the candidate text, it must never send
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key !== 'Enter') return;
        // newline/sending is handled EXPLICITLY — relying on the browser's default
        // insertion is unreliable across webviews and mobile keyboards
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
        // execCommand keeps the native undo stack; setRangeText is the fallback
        let inserted = false;
        try {
            inserted = document.execCommand('insertText', false, '\n');
        } catch {
            /* execCommand unavailable — the setRangeText fallback below applies */
        }
        if (!inserted) input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        autoGrowChatInput();
    }

    /**
     * Give the server copies of an outgoing chat message for the history store.
     * Live delivery stays P2P over the DataChannel mesh; this relay is storage
     * only (the sender is the single reporting point, so nothing is stored
     * twice). A submit with images = one head event + one event per image —
     * each image rides alone because a whole batch can exceed the socket.io
     * packet cap; the server assembles the batch into one history row.
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

        // edit mode: resubmit one's own already-sent row (text only; the server
        // broadcasts the persisted result back to everyone including us)
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
        clearPendingImages(); // the tray is emptied up-front; failures toast per image

        const reply = replyPayload();
        cancelReply();

        if (!images.length) {
            trySendChat({ type: 'chat', from: s.selfName, msg: text, reply });
            s.chat.add({ name: s.selfName, text, self: true, reply });
            emitChatForHistory(text, [], reply);
            return;
        }

        // text + images go out as ONE batch = one merged bubble on every receiver
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
                sendImageData({
                    send: (frame) => s.mesh.sendChat(frame),
                    from: s.selfName,
                    mime: payload.mime,
                    dataUrl: payload.dataUrl,
                    batch,
                });
            } catch {
                // a DataChannel refused the frames (send buffer full / channel
                // closing) — stop here instead of silently losing the remaining
                // images of the batch
                toast(t('chat.imageSendFailed'), 'warn');
                break;
            }
            s.chat.addBatchImage(batch, payload.dataUrl, t('chat.image'));
        }
    }

    /**
     * mesh.sendChat with a delivery-failure path: a DataChannel refusing frames
     * (buffer full / closing) must not surface as an uncaught throw. Returns
     * false — after toasting — when the frame could not be delivered.
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
    // chat search — filters the RENDERED rows (loaded pages only, no server round
    // trip); the counter says how many of the loaded messages match
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
    // pending image tray (composer attachments)
    // -------------------------------------------------------------------------

    function bindImageUi() {
        $('#imageBtn').addEventListener('click', () => $('#imageFileInput').click());
        $('#imageFileInput').addEventListener('change', (event) => {
            const files = [...(event.target.files || [])];
            event.target.value = ''; // allow re-picking the same file
            for (const file of files) addPendingImage(file);
        });

        // pasted images land in the composer tray, so text or more images can be
        // added before everything goes out together
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
