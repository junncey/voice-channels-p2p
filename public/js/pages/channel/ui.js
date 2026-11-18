/*
频道页的 UI 事件接线：按钮/表单/窗口级监听的一次性绑定。
从 channel.js 拆出——只做绑定，不含业务状态；共享状态经 `s`
存取器、跨模块面经晚绑定的 `x` 到达（两者都归 channel.js 所有）。
*/

import { api } from '/js/core/api.js';
import { t } from '/js/core/i18n.js';
import { $, copyText, toast } from '/js/core/utils.js';

export function createUi({ s, x, channelId }) {
    const { hostAuth, mem, rec, voice, composer, settings: settingsUi } = x;

    function bind() {
        $('#backBtn').addEventListener('click', x.leave);
        $('#joinBtn').addEventListener('click', () => x.join({ textOnly: false }));
        $('#textOnlyBtn').addEventListener('click', () => x.join({ textOnly: true }));

        $('#hostLoginBtn').addEventListener('click', hostAuth.openHostModal);
        $('#hostLoginEntryBtn').addEventListener('click', hostAuth.openHostModal);
        $('#hostCancelBtn').addEventListener('click', hostAuth.closeHostModal);
        $('#hostLoginForm').addEventListener('submit', hostAuth.onHostLoginSubmit);

        $('#renameCancelBtn').addEventListener('click', mem.closeRenameModal);
        $('#renameForm').addEventListener('submit', mem.onRenameSubmit);
        $('#renameModal').addEventListener('click', (event) => {
            if (event.target === $('#renameModal')) mem.closeRenameModal();
        });

        $('#copyLinkBtn').addEventListener('click', async () => {
            const ok = await copyText(`${location.origin}/c/${channelId}`);
            if (ok) toast(t('channel.copied'), 'ok');
        });

        $('#exportChatBtn').addEventListener('click', async () => {
            if (!s.isPresenter || !s.hostToken) return;
            try {
                await api.hostExport(channelId, s.hostToken);
                toast(t('channel.exportDone'), 'ok');
            } catch (err) {
                toast(err?.status === 404 ? t('channel.errors.channelNotFound') : t('common.error'), 'warn');
            }
        });

        $('#leaveBtn').addEventListener('click', x.leave);
        $('#outageActionBtn').addEventListener('click', () => {
            if ($('#outageBanner').dataset.mode === 'failed') {
                s.intentionalUnload = true;
                location.reload();
            } else rec.attemptSignalingReconnect({ manual: true });
        });
        $('#micBtn').addEventListener('click', voice.onMicBtnClick);
        $('#deafenBtn').addEventListener('click', voice.toggleDeafen);
        voice.bindShareSoundButton();
        voice.bindPttHoldButton();
        $('#chatForm').addEventListener('submit', composer.onChatSubmit);
        composer.bindChatInput();
        composer.bindChatSearch();
        settingsUi.bindAppearanceControls();

        composer.bindImageUi();
        settingsUi.bindSettingsUi();

        $('#lockBtn').addEventListener('click', () => {
            if (!s.socket || !s.joined || !s.isPresenter) return;
            const action = s.joinLockOn ? 'joinLockOff' : 'joinLockOn';
            // 房间广播不回发给自己，所以新状态要在本地立即反映
            s.joinLockOn = action === 'joinLockOn';
            x.updateHeaderActions();
            s.chat.add({ text: t(`channel.${action}`, { name: s.selfName }), system: true });
            s.socket.emit('roomAction', {
                room_id: channelId,
                peer_name: s.selfName,
                peer_uuid: s.selfUuid,
                action,
            });
        });

        // 版本横幅重载前已有自己的确认 —— 就当用户已同意，
        // 免得浏览器再问第二次（见 version.js 的 reloadNow）
        window.addEventListener('vc:unload-intent', () => {
            s.intentionalUnload = true;
        });
        // 会话中途被挂起的 AudioContext 在任意后续手势上恢复
        // （iOS 来电打断、系统音频会话丢失）—— 归 voice.js 管
        voice.bindResumeOnGesture();
        // 连着频道时的原生「离开页面？」确认 ——
        // 文案由浏览器自行本地化渲染，returnValue 是 Chrome/Edge 的
        // 老式开关。这里不做任何清理：该对话框可取消，且取消后
        // 会话必须照常工作，所以拆除等到 pagehide 才做
        // （pagehide 只在真正卸载时触发，包括完全跳过 beforeunload 的
        // iOS 侧滑关闭）。
        window.addEventListener('beforeunload', (e) => {
            if (s.intentionalUnload || !s.joined) return;
            e.preventDefault();
            e.returnValue = '';
        });
        window.addEventListener('pagehide', () => {
            s.socket?.disconnect();
            x.teardownMedia();
        });
        // 从 bfcache 返回：pagehide 已断开 socket 并停了麦克风，但
        // 页面看起来仍在频道里 —— 一个无声又听不见的空频道。重载重进，
        // 而不是让用户对着空气说话。
        window.addEventListener('pageshow', (e) => {
            if (!e.persisted) return;
            s.intentionalUnload = true;
            location.reload();
        });
        // （visibilitychange 上的 wake lock 重武装归 channel/wakeLock.js 管）
    }

    return { bind };
}
