'use strict';

/**
 * Shared wire-format limits and shapes for the server modules.
 *
 * One source of truth for every cap that used to be copy-pasted across
 * server.js / chatStore.js / channelStore.js / restore.js (and is mirrored
 * client-side in public/js — see images.js). Values must stay in sync with
 * the client, so each entry notes its client twin.
 */

// Channel ids: 3-32 chars, URL-safe. Doubles as path-traversal protection
// (ids become filenames in chat_history/). Source form (no anchors) so it
// can be embedded into larger filename regexes (see restore.js).
const CHANNEL_ID_SOURCE = '[a-zA-Z0-9_-]{3,32}';
const CHANNEL_ID_RE = new RegExp('^' + CHANNEL_ID_SOURCE + '$');

// data:image/* whitelist — validated directly and NEVER routed through
// checkXSS (DOMPurify strips data: URIs). Same shape client-side (images.js).
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;

// Member display names (join, peerName, chat rows). Client twin: the join
// form caps input at 24 chars.
const PEER_NAME_MAX = 24;
// Chat message text (composer: input.trim().slice(0, 500) client-side)
const CHAT_TEXT_MAX = 500;
// Reply-quote snippet rendered inside the reply bubble
const REPLY_TEXT_MAX = 80;
// Reaction emoji string (some emoji carry several code points + modifiers)
const REACTION_EMOJI_MAX = 16;
// Per-image transfer cap — mirrors the client cap (images.js MAX_TRANSFER_CHARS)
const IMAGE_MAX_CHARS = 1600 * 1024;
// Custom avatar: same data-URL whitelist, smaller cap (channel.js client twin)
const AVATAR_MAX_CHARS = 96 * 1024;
// Default room capacity when a channel defines none
const DEFAULT_MAX_PARTICIPANTS = 8;

module.exports = {
    CHANNEL_ID_SOURCE,
    CHANNEL_ID_RE,
    IMAGE_DATA_URL_RE,
    PEER_NAME_MAX,
    CHAT_TEXT_MAX,
    REPLY_TEXT_MAX,
    REACTION_EMOJI_MAX,
    IMAGE_MAX_CHARS,
    AVATAR_MAX_CHARS,
    DEFAULT_MAX_PARTICIPANTS,
};
