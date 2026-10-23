// src/lib/globalOptOut.js
//
// A viewer's opt-out from TTS in every channel.
//
// It lives on the viewer's own `ttsUserPreferences/<twitchUserId>` document,
// not on any channel config, because it belongs to the viewer and no moderator
// can set or clear it. The web dashboard is the only writer
// (`PUT /api/viewer/opt-out` in chatvibes-web-ui):
//
//     globalOptOut     true while the viewer is opted out; deleted otherwise
//     globalOptOutAt   ISO 8601 string, display only; deleted with the flag
//
// It stops TTS from speaking the viewer's own words. It does not stop event
// announcements (subs, cheers, gifts, raids, redemptions): those are spoken
// without the message the viewer attached to them. The per-channel ignore list
// is stricter and skips the whole announcement. See docs/ignore-list.md.

export const GLOBAL_OPT_OUT_FIELD = 'globalOptOut';
export const GLOBAL_OPT_OUT_AT_FIELD = 'globalOptOutAt';

/**
 * Whether the viewer's global preferences carry the opt-out.
 * @param {object|null|undefined} globalUserPrefs From getGlobalUserPreferences
 * @returns {boolean}
 */
export function isGloballyOptedOut(globalUserPrefs) {
    return globalUserPrefs?.[GLOBAL_OPT_OUT_FIELD] === true;
}
