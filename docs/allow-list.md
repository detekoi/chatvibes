# Allow-list vs. active (`managedChannels`)

`src/lib/allowList.js` answers two separate questions, and conflating them is a bug:

- `isChannelAllowed()` — the channel is **approved** to use the service, which means a
  `managedChannels` document exists for it. Approval is granted by an admin creating the document;
  the web UI's `/api/bot/add` refuses to activate a channel that has none.
- `isChannelActive()` — the bot is **switched on** (`isActive: true` on that document).

"Deactivate TTS Service" in the dashboard clears `isActive` and keeps the document, so a channel
that stops using the bot stays approved: its OBS overlay socket and its dashboard keep working, and
switching the bot back on needs no re-approval. Only deleting the document revokes approval.
The one exception is deleting a legacy login-keyed document (no `twitchUserId`) when a document
keyed by the same channel's ID also exists. That used to revoke the live channel too, because
removal followed the login to the ID. `removeAllowedChannel` now leaves the channel approved.

Gate on `isChannelActive` anything that speaks or reacts in a channel (EventSub events, channel
point redemptions) — a stale EventSub subscription can outlive the deactivation that unsubscribed
it. Gate on `isChannelAllowed` anything that merely belongs to the channel owner (the overlay
WebSocket, the settings API). The sibling ChatSage bot (`twitch-knowledge-bot`) mirrors this split,
except that its allow-list fails closed with no startup grace period.
