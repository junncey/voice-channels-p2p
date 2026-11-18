'use strict';

/**
 * 服务端各模块共享的线格式上限与形状常量。
 *
 * 曾经在 server.js / chatStore.js / channelStore.js / restore.js 之间
 * 复制粘贴的每一个上限，如今都汇聚到这一处（public/js 有客户端镜像
 * ——见 images.js）。这些值必须与客户端保持同步，
 * 因此每个条目都注明了它在客户端的对应常量。
 */

// 频道 ID：3-32 字符、URL 安全。兼作路径穿越防护
// （ID 会成为 chat_history/ 下的文件名）。采用无锚点的 source 形式，
// 便于嵌入更大的文件名正则（见 restore.js）。
const CHANNEL_ID_SOURCE = '[a-zA-Z0-9_-]{3,32}';
const CHANNEL_ID_RE = new RegExp('^' + CHANNEL_ID_SOURCE + '$');

// data:image/* 白名单——直接校验，绝不经过 checkXSS
// （DOMPurify 会剥掉 data: URI）。客户端有相同形状的镜像（images.js）。
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;

// 成员显示名（join、peerName、聊天行）。客户端对应物：加入表单
// 输入上限 24 字符。
const PEER_NAME_MAX = 24;
// 聊天正文（客户端 composer 侧为 input.trim().slice(0, 500)）
const CHAT_TEXT_MAX = 500;
// 回复引用摘要（渲染在回复气泡内）
const REPLY_TEXT_MAX = 80;
// 表情回应的 emoji 字符串（有的 emoji 含多个码点+修饰符）
const REACTION_EMOJI_MAX = 16;
// 表情回应：每条消息的不同 emoji 数、每个 emoji 的回应者名字数
const REACTIONS_MAX_EMOJI = 8;
const REACTIONS_MAX_NAMES = 50;
// 单条消息携带的图片张数——与客户端批次协议相同的上限
// （chatGateway 的 head/imgs 事件与 chatStore 存储共用）
const MAX_IMAGES_PER_MESSAGE = 9;
// 图片批次 id（客户端生成的字符串）的长度上限
const IMG_BATCH_ID_MAX = 64;
// 单图传输上限——镜像客户端上限（images.js 的 MAX_TRANSFER_CHARS）
const IMAGE_MAX_CHARS = 1600 * 1024;
// 自定义头像：同一 data-URL 白名单、更小的上限（客户端对应在 channel.js）
const AVATAR_MAX_CHARS = 96 * 1024;
// 频道未定义人数时的默认房间容量
const DEFAULT_MAX_PARTICIPANTS = 8;

module.exports = {
    CHANNEL_ID_SOURCE,
    CHANNEL_ID_RE,
    IMAGE_DATA_URL_RE,
    PEER_NAME_MAX,
    CHAT_TEXT_MAX,
    REPLY_TEXT_MAX,
    REACTION_EMOJI_MAX,
    REACTIONS_MAX_EMOJI,
    REACTIONS_MAX_NAMES,
    MAX_IMAGES_PER_MESSAGE,
    IMG_BATCH_ID_MAX,
    IMAGE_MAX_CHARS,
    AVATAR_MAX_CHARS,
    DEFAULT_MAX_PARTICIPANTS,
};
