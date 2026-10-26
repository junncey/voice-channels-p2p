/*
Member list — the room roster UI of the channel page.

Owns the members Map (peerId -> joined info, session-uuid keyed) and the
name-keyed custom-avatar cache, renders the member cards (badges, per-user
volume slider, host moderation actions) and keeps the roster in sync with
the server's peers map. Recovery badges are read from the recovery engine's
maps; audio teardown of a departing peer goes through the shared audioEls.
Shared page state arrives via the `s` accessor object, cross-module calls
via the late-bound `x` surface (both owned by channel.js).
*/

export function createMembers({
    s,
    x,
    rec,
    members,
    avatars,
    audioEls,
    channelId,
    peerVolumes,
    shareSound,
    avatarColor,
    AVATAR_MAX_CHARS,
    AVATARS_MAX,
    DATA_URL_RE,
    $,
    el,
    t,
}) {
    const MIC_ON_SVG =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
    const MIC_OFF_SVG =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4" y1="4" x2="20" y2="20"/></svg>';
    const VOL_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    const DEAFEN_SVG =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 14a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1"/><path d="M3 14a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2H5"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
    const SHARE_SVG =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

    /** peerId -> { peer_name, peer_presenter, peer_audio_status, joined_at, volume, self }
     *  (the Map itself is shared page state, created by channel.js) */

    function syncMembers(peersMap) {
        // peer ids are SESSION uuids (stable across our own reconnects) — our own
        // id is selfUuid, never the ephemeral socket.id
        const selfId = s.selfUuid;
        for (const [peerId, info] of Object.entries(peersMap)) {
            if (roomMetaKey(peerId)) continue;
            if (peerId === selfId) continue;
            const existing = members.get(peerId);
            const name = info.peer_name || existing?.peer_name || '?';
            const avatar =
                typeof info.peer_avatar === 'string' &&
                info.peer_avatar.length <= AVATAR_MAX_CHARS &&
                DATA_URL_RE.test(info.peer_avatar)
                    ? info.peer_avatar
                    : existing?.avatar;
            if (avatar) {
                avatars.set(name, avatar);
                capAvatars();
            }
            members.set(peerId, {
                peer_name: name,
                peer_presenter: !!info.peer_presenter,
                peer_audio_status: info.peer_audio_status === true,
                peer_deafen: info.peer_deafen === true,
                peer_share: info.peer_share === true,
                joined_at: info.joined_at || existing?.joined_at || Date.now(),
                avatar,
                // remembered per-user volume; an in-session adjustment wins over the stored one
                volume: existing?.volume ?? (name !== '?' ? (peerVolumes[name] ?? 1) : 1),
            });
            if (!existing) rec.armConnectingBadge(peerId);
        }
        // drop stale entries
        for (const peerId of [...members.keys()]) {
            if (peerId === selfId) continue;
            if (!peersMap[peerId]) dropPeer(peerId, { silent: true });
        }
        ensureSelfMember();
        renderMembers();
    }

    function roomMetaKey(key) {
        return key === 'lock' || key === 'password' || key === 'joinLock';
    }

    function ensureSelfMember() {
        members.set(s.selfUuid, {
            peer_name: s.selfName,
            peer_presenter: s.isPresenter,
            peer_audio_status: x.onAir(),
            peer_deafen: s.deafened,
            peer_share: shareSound.active(),
            joined_at: 0, // self always first
            avatar: s.selfAvatar || undefined,
            self: true,
        });
        if (s.selfAvatar) avatars.set(s.selfName, s.selfAvatar);
    }

    function dropPeer(peerId, { silent = false } = {}) {
        rec.forgetPeer(peerId);
        members.delete(peerId);
        pruneAvatars();
        s.mesh?.removePeer(peerId);
        s.hub?.unwatch(peerId);
        s.hub?.stopPeer(peerId);
        const audio = audioEls.get(peerId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            audioEls.delete(peerId);
        }
        if (!silent) renderMembers();
    }

    /** avatars is keyed by display name — forget names no longer in the room. */
    function pruneAvatars() {
        const present = new Set();
        for (const info of members.values()) {
            if (info.peer_name) present.add(info.peer_name);
        }
        for (const name of [...avatars.keys()]) {
            if (!present.has(name)) avatars.delete(name);
        }
    }

    /** Belt-and-braces: a peer cycling nicknames+avatars can't grow the map forever. */
    function capAvatars() {
        while (avatars.size > AVATARS_MAX) avatars.delete(avatars.keys().next().value);
    }

    function memberAvatarNode(info) {
        if (info.avatar) {
            const img = el('img', { class: 'member-avatar img', alt: '' });
            img.src = info.avatar; // validated data URL
            return img;
        }
        return el(
            'div',
            { class: 'member-avatar', style: { background: avatarColor(info.peer_name) } },
            (info.peer_name || '?').trim().charAt(0).toUpperCase() || '?'
        );
    }

    function micIconNode(on) {
        return el('span', {
            class: 'member-mic' + (on ? '' : ' off'),
            html: on ? MIC_ON_SVG : MIC_OFF_SVG,
        });
    }

    /** Headphones-off badge on a member card (visible while self-deafened). */
    function deafenIconNode(on) {
        return el('span', {
            class: 'member-deafen' + (on ? ' on' : ''),
            title: t('channel.deafenBadge'),
            html: DEAFEN_SVG,
        });
    }

    /** Music-note badge on a member card — that member is sharing sound into the channel. */
    function shareIconNode(on) {
        return el('span', {
            class: 'member-share' + (on ? ' on' : ''),
            title: t('channel.shareBadge'),
            html: SHARE_SVG,
        });
    }

    /** Per-user volume row (0-300%), revealed on card hover. */
    function memberVolumeNode(peerId, info) {
        const initial = Math.round((info.volume ?? 1) * 100);
        const value = el('span', { class: 'member-volume-val', text: `${initial}%` });
        const slider = el('input', {
            type: 'range',
            min: 0,
            max: 300,
            step: 5,
            value: String(initial),
            title: t('channel.userVolume'),
        });
        slider.addEventListener('input', () => {
            info.volume = Number(slider.value) / 100;
            value.textContent = `${slider.value}%`;
            slider.closest('.member-volume')?.classList.add('adjusted');
            x.savePeerVolume(info.peer_name, info.volume);
            x.reapplyPeerVolume(peerId);
        });
        return el(
            'div',
            { class: 'member-volume' + (initial !== 100 ? ' adjusted' : '') },
            el('span', { class: 'member-volume-icon', html: VOL_SVG }),
            slider,
            value
        );
    }

    function renderMembers() {
        const list = $('#memberList');
        const sorted = [...members.entries()].sort((a, b) => {
            const [, a2] = a;
            const [, b2] = b;
            if (!!a2.self !== !!b2.self) return a2.self ? -1 : 1;
            if (!!a2.peer_presenter !== !!b2.peer_presenter) return a2.peer_presenter ? -1 : 1;
            return (a2.joined_at || 0) - (b2.joined_at || 0);
        });

        list.replaceChildren(
            ...sorted.map(([peerId, info]) => {
                const node = el('li', {
                    class:
                        'member' +
                        (info.self ? ' self-member' : '') +
                        (rec.peerRecovery.has(peerId) ? ' lost' : '') +
                        (rec.stuckConnecting.has(peerId) ? ' connecting' : '') +
                        (rec.lossStreaks.get(peerId)?.unstable ? ' unstable' : ''),
                    dataset: { id: peerId },
                });
                node.append(
                    memberAvatarNode(info),
                    el(
                        'div',
                        { class: 'member-info' },
                        el(
                            'div',
                            { class: 'member-name' },
                            `${info.peer_name}`,
                            info.self ? el('span', { class: 'you', text: `（${t('channel.you')}）` }) : null
                        ),
                        el(
                            'div',
                            { class: 'member-sub' },
                            info.peer_presenter
                                ? el('span', { class: 'badge host', text: t('channel.hostBadge') })
                                : null,
                            info.self && s.textOnly
                                ? el('span', { class: 'badge', text: t('channel.textOnlyBadge') })
                                : null,
                            !info.self
                                ? el('span', { class: 'badge connect-badge', text: t('channel.peerConnecting') })
                                : null,
                            !info.self
                                ? el('span', { class: 'badge recover-badge', text: t('channel.peerOffline') })
                                : null,
                            !info.self
                                ? el('span', { class: 'badge unstable-badge', text: t('channel.peerUnstable') })
                                : null,
                            !info.self ? rec.pathBadgeNode(peerId) : null,
                            deafenIconNode(!!info.peer_deafen),
                            shareIconNode(!!info.peer_share),
                            micIconNode(info.peer_audio_status)
                        )
                    )
                );

                if (!info.self) node.append(memberVolumeNode(peerId, info));

                if (s.isPresenter && !info.self) {
                    node.append(
                        el(
                            'div',
                            { class: 'member-actions' },
                            el('button', {
                                class: 'btn ghost sm',
                                text: t('channel.renameMember'),
                                onclick: () => renamePeer(peerId),
                            }),
                            el('button', {
                                class: 'btn ghost sm',
                                text: t('channel.muteMember'),
                                onclick: () => mutePeer(peerId),
                            }),
                            el('button', {
                                class: 'btn danger sm',
                                text: t('channel.removeMember'),
                                onclick: () => kickPeer(peerId),
                            })
                        )
                    );
                }

                // touch fallback: hover never happens on a phone, so tapping a
                // member row reveals the volume slider (and host actions) instead
                node.addEventListener('click', (event) => {
                    if (event.target.closest('button, input, a')) return;
                    const wasOpen = node.classList.contains('open');
                    for (const other of list.querySelectorAll('.member.open')) other.classList.remove('open');
                    if (!wasOpen) node.classList.add('open');
                });

                return node;
            })
        );
        $('#memberCount').textContent = String(members.size);
    }

    /**
     * Update one member's mic icon in place — remote peerStatus flips (and local
     * push-to-talk) must not rebuild the list, or a volume slider mid-drag dies.
     */
    function updateMicIconNode(peerId, on) {
        const node = $(`#memberList .member[data-id="${peerId}"] .member-mic`);
        if (!node) {
            renderMembers();
            return;
        }
        node.className = 'member-mic' + (on ? '' : ' off');
        node.innerHTML = on ? MIC_ON_SVG : MIC_OFF_SVG;
    }

    function updateOnlineCount() {
        $('#onlineCount').textContent = t('index.online', { n: members.size });
        $('#memberCount').textContent = String(members.size);
    }

    // -------------------------------------------------------------------------
    // host actions / moderation
    // -------------------------------------------------------------------------

    function mutePeer(peerId) {
        s.socket.emit('peerAction', {
            room_id: channelId,
            peer_name: s.selfName,
            peer_uuid: s.selfUuid,
            peer_id: peerId,
            peer_action: 'muteAudio',
            send_to_all: false,
        });
    }

    function kickPeer(peerId) {
        s.socket.emit('kickOut', {
            room_id: channelId,
            peer_name: s.selfName,
            peer_uuid: s.selfUuid,
            peer_id: peerId,
            peer_kicked_reason: 'removed by host',
        });
    }

    // ----- host renames a member's joined nickname -----

    let renameTarget = null; // peerId the rename modal is editing

    function renamePeer(peerId) {
        renameTarget = peerId;
        $('#renameInput').value = members.get(peerId)?.peer_name || '';
        $('#renameError').textContent = '';
        $('#renameModal').classList.remove('hidden');
        $('#renameInput').focus();
        $('#renameInput').select();
    }

    function closeRenameModal() {
        renameTarget = null;
        $('#renameModal').classList.add('hidden');
    }

    function onRenameSubmit(event) {
        event.preventDefault();
        const name = $('#renameInput').value.trim().slice(0, 24);
        if (!name) {
            $('#renameError').textContent = t('channel.errors.nickRequired');
            return;
        }
        if (renameTarget && members.get(renameTarget)?.peer_name !== name) {
            s.socket.emit('peerRename', {
                room_id: channelId,
                peer_name: s.selfName,
                peer_uuid: s.selfUuid,
                peer_id: renameTarget,
                peer_name_new: name,
            });
        }
        closeRenameModal();
    }

    /** Button content from a static SVG constant + a textContent label — never
     * string-built HTML, so a future interpolated label can't become an XSS sink. */
    function setIconBtn(btn, icon, label) {
        btn.replaceChildren(el('span', { html: icon }), el('span', { text: label }));
    }

    return {
        syncMembers,
        ensureSelfMember,
        dropPeer,
        renderMembers,
        updateMicIconNode,
        updateOnlineCount,
        memberAvatarNode,
        capAvatars,
        mutePeer,
        kickPeer,
        renamePeer,
        closeRenameModal,
        onRenameSubmit,
        setIconBtn,
        MIC_ON_SVG,
        MIC_OFF_SVG,
    };
}
