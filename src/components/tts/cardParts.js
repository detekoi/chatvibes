// src/components/tts/cardParts.js
// The emotes on the spotlight card.
//
// A card (`display` on a queue item) can carry `parts`: the message as a list of
// text parts and emote parts, in order. The player shows an emote part as an image,
// and a text part as text. A card without an emote has no parts; its `text` is enough.
//
// An emote part is `{ type: 'emote', name, src }`. `src` is an HTTPS image URL on a
// host in EMOTE_HOSTS. The player checks the host again (tts-player.js keeps its own
// copy of the list, because it cannot import this file). Change both together.

// Twitch serves its emotes from static-cdn.jtvnw.net. YouTube custom emotes come from
// the Google image hosts that the chat overlay in wildcat-home also accepts.
const EMOTE_HOSTS = ['static-cdn.jtvnw.net', 'ggpht.com', 'googleusercontent.com', 'ytimg.com', 'gstatic.com'];
// Twitch emote IDs are digits, or "emotesv2_" and hex digits.
const TWITCH_EMOTE_ID = /^[A-Za-z0-9_]{1,64}$/;
const NAME_MAX = 50;

/** True if `src` is an HTTPS URL on an emote host. */
export function isEmoteSrc(src) {
    if (typeof src !== 'string' || src.length > 2048) return false;
    let url;
    try {
        url = new URL(src);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname;
    return EMOTE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

/** Twitch's image URL of an emote. The 2.0 size is sharp at the card's emote size. */
function twitchEmoteSrc(id) {
    return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

/** The parts, or undefined when no part is an emote. */
function withEmotes(parts) {
    return parts.some(p => p.type === 'emote') ? parts : undefined;
}

/**
 * Card parts from the fragments of a Twitch EventSub chat message. Every fragment
 * that is not an emote (text, mention, cheermote) becomes text.
 * @param {Array<{type: string, text: string, emote?: {id?: string}}>|null|undefined} fragments
 * @returns {Array<object>|undefined}
 */
export function cardPartsFromTwitch(fragments) {
    if (!Array.isArray(fragments)) return undefined;
    const parts = [];
    for (const f of fragments) {
        if (!f || typeof f.text !== 'string') continue;
        const id = f.type === 'emote' ? f.emote?.id : null;
        if (typeof id === 'string' && TWITCH_EMOTE_ID.test(id)) {
            parts.push({ type: 'emote', name: f.text, src: twitchEmoteSrc(id) });
        } else {
            parts.push({ type: 'text', text: f.text });
        }
    }
    return withEmotes(parts);
}

/**
 * Card parts from the emote fragments that yt-chat-proxy sends with a YouTube
 * message. The name of an emote is its shortcut (":hand-pink-waving:"), as chat
 * shows it, or else its label.
 * @param {Array<{type: string, text?: string, imageUrl?: string, label?: string}>|null|undefined} fragments
 * @returns {Array<object>|undefined}
 */
export function cardPartsFromYouTube(fragments) {
    if (!Array.isArray(fragments)) return undefined;
    const parts = [];
    for (const f of fragments) {
        if (!f) continue;
        if (f.type === 'yt_emote') {
            const name = (typeof f.text === 'string' && f.text) || (typeof f.label === 'string' && f.label) || '';
            if (isEmoteSrc(f.imageUrl)) parts.push({ type: 'emote', name, src: f.imageUrl });
            else if (name) parts.push({ type: 'text', text: name });
        } else if (typeof f.text === 'string') {
            parts.push({ type: 'text', text: f.text });
        }
    }
    return withEmotes(parts);
}

function codePointLength(text) {
    return Array.from(text).length;
}

/**
 * The parts of a card, made safe to show and cut to `max` code points. An emote
 * counts as the length of its name, so the cut matches the one of `text`.
 *
 * `cleanText` is the filter of the card text (sound tags and profanity). It runs on
 * each text part and on each emote name: the player shows the name if the image does
 * not load. An emote with a bad `src` becomes text. Whitespace is collapsed, and
 * adjacent text parts are joined.
 *
 * @param {unknown} parts
 * @param {(text: string) => string} cleanText
 * @param {number} max
 * @returns {{parts: Array<object>|undefined, text: string}|null} Null when the parts
 *     have no emote. `text` is the cut card as plain text, with each emote as its
 *     name. `parts` is undefined when the cut removed every emote.
 */
export function cleanCardParts(parts, cleanText, max) {
    if (!Array.isArray(parts)) return null;
    const clean = [];
    const pushText = (text) => {
        if (!text) return;
        const last = clean.at(-1);
        if (last && last.type === 'text') last.text += text;
        else clean.push({ type: 'text', text });
    };
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'emote') {
            const name = cleanText(String(part.name ?? '')).replace(/\s+/g, ' ').trim();
            const short = Array.from(name).slice(0, NAME_MAX).join('');
            if (isEmoteSrc(part.src) && short) clean.push({ type: 'emote', name: short, src: part.src });
            else pushText(short);
        } else if (part.type === 'text') {
            pushText(cleanText(String(part.text ?? '')).replace(/\s+/g, ' '));
        }
    }
    // The filters can leave a double space where two parts meet.
    for (let i = 0; i < clean.length; i++) {
        const part = clean[i];
        if (part.type !== 'text') continue;
        if (i === 0) part.text = part.text.trimStart();
        if (i === clean.length - 1) part.text = part.text.trimEnd();
        if (i > 0 && clean[i - 1].type === 'text') part.text = part.text.trimStart();
    }
    const kept = clean.filter(p => p.type === 'emote' || p.text);
    if (!kept.some(p => p.type === 'emote')) return null;

    const lengthOf = p => codePointLength(p.type === 'emote' ? p.name : p.text);
    const total = kept.reduce((n, p) => n + lengthOf(p), 0);
    let cut = kept;
    if (total > max) {
        cut = [];
        let room = max - 1; // one code point for the ellipsis
        for (const part of kept) {
            const length = lengthOf(part);
            if (length <= room) {
                cut.push(part);
                room -= length;
                continue;
            }
            const head = part.type === 'text' ? Array.from(part.text).slice(0, room).join('').trimEnd() : '';
            const last = cut.at(-1);
            if (last && last.type === 'text' && !head) last.text = `${last.text.trimEnd()}…`;
            else cut.push({ type: 'text', text: `${head}…` });
            break;
        }
    }
    const text = cut.map(p => (p.type === 'emote' ? p.name : p.text)).join('');
    // The cut can remove the last emote. The card is then plain text.
    return { parts: withEmotes(cut), text };
}
