/*
头像节点的共享渲染：自定义 data URL 成 <img>，否则以名字散列色
为底、首字母大写。聊天行（chat.js）与成员卡片（members.js）共用
——此前是两份手抄副本，已经漂移过一次。
*/

import { el, avatarColor } from './utils.js';
import { DATA_URL_RE } from './images.js';

/**
 * 构建头像节点。
 * @param {string} name 显示名（决定散列色与兜底首字母）
 * @param {string|null} url 自定义头像（校验过的 data:image URL；
 *     非法或缺失时渲染首字母底色）
 * @param {string} cls 容器类名（'msg-avatar' / 'member-avatar'）
 */
export function buildAvatarNode(name, url, cls) {
    if (url && DATA_URL_RE.test(url)) {
        const img = el('img', { class: `${cls} img`, alt: '' });
        img.src = url; // 创建后设置；src 是校验过的 data URL
        return img;
    }
    return el(
        'div',
        { class: cls, style: { background: avatarColor(name) } },
        (name || '?').trim().charAt(0).toUpperCase() || '?'
    );
}
