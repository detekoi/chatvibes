# Running on several instances (channel ownership)

Cloud Run runs up to 10 instances of this service (`maxScale: 10`, `min-instances 0`, CPU only
while a request is open, session affinity on). Twitch's webhooks are spread across whichever
instances are up, and the logs for 2026-08-30 to 2026-09-29 show two instances handling TTS at
once in about one ten-minute window in five, and 28% of clips (570 of 2,000) arriving on an
instance other than the one holding the channel's browser source.

**What goes wrong when a channel's events are split between instances** is everything that lives
in one process's memory: the TTS queue (pending clips, `!tts pause`, who is speaking, which
`!tts stop` checks), redemptions held until a moderator approves them (`redemptionCache`), the
chat fragments paired with a redemption (`redemptionFragmentCache`), the `.add`/`.update` echo
guard (`announcedRedemptions`) and shared-chat sessions (`sharedChatManager`). A `!tts stop`
whose webhook landed on the wrong instance stopped nothing; an approval whose `.update` landed on
the wrong instance was never announced. Unlike twitch-knowledge-bot, nothing here posts to chat
on a timer, so the "every timer message three times" incident has no counterpart; the jobs that
must run once (EventSub subscription sync, the channel change listener, the language sync)
already run only on the leader (`leaderElection.js`).

## The design

**Each channel is leased to the instance holding its browser source** (`src/lib/channelOwnership.js`,
`channelLeases/{broadcasterId}`). The lease has a 30s TTL, is renewed every 10s, and the holder
stops acting 5s before it could expire. It is claimed when a browser source authenticates
(`notePlayer`, from `webSocket.js`), renewed while one is attached, and released 30s after the
last one leaves, or on SIGTERM.

**Webhooks that land elsewhere are forwarded** (`channelInbox.js`,
`channelInbox/{broadcasterId}/inboxEvents/{messageId}`). `routeNotification` in `eventsub.js`
claims the message as before, then reads the lease: if another live instance holds it, the raw
webhook is written to that channel's inbox and the owner, which listens with `onSnapshot`,
claims it by deleting it in a transaction and runs `processNotification`. Chat older than
2 minutes and other events older than 10 minutes are dropped at the owner. Firestore resets
long-lived listener streams now and then, and the lease keeps renewing through it without
announcing the channel again, so a failed inbox listener reopens itself (1s, 5s, 15s, 30s, then
every 60s) for as long as the channel is owned; its first snapshot after reopening carries what
was forwarded in between. No lease, a Firestore
error, or ownership switched off: the webhook is handled where it landed, exactly as before, and
its audio reaches the browser source over Pub/Sub if there is one.

**The queue moves with the channel** (`channelHandover.js`). An instance that gives a channel up
deletes the lease first, while still reading the inbox, so other instances stop forwarding to it
before it stops listening; the reverse order stranded whatever they forwarded in between. Then
it writes its pending clips, and its pause, to the channel's inbox as a `queueHandoff`, which the
next owner picks up whenever it starts listening. The new owner puts them
ahead of anything it queued since. It also restores `ttsQueuePersistence/{broadcasterId}`, which
is where a shutdown with ownership off, or a handoff that could not be written, leaves a queue.
`restoreAllQueues` at startup runs only with ownership off: it handed every saved queue to
whichever instance started first, player or not.

**`TTS_TIMING` reports the hop** as `route: 'inbox'` with `inboxHopMs` (forward to pickup);
`handlerMs` includes it, as it includes the Pub/Sub hop on that route.

## Why the owner is the browser source's instance

twitch-knowledge-bot lets any instance own a channel: the first to see a webhook claims it, and a
sweep spreads orphaned live channels over the instances, capped at a fair share (heartbeats in
`botInstances`). None of that carries over.

- **The audio can only leave on the browser source's socket**, which is attached to one instance.
  An owner without it would hold the queue and have nobody to play it to.
- **CPU is only allocated during requests.** An instance that owned channels because it once got a
  webhook would be throttled between webhooks and miss renewals. The browser source's socket is
  an open request, so the owner always has CPU.
- **There is nothing to balance.** Where the socket lands is Cloud Run's choice, so the fair-share
  sweep and the heartbeat collection were dropped. The sweep that remains only claims channels
  whose browser source is attached here and whose lease has no live holder.

**A holder whose browser source has gone can be taken over** by an instance that has it: the lease
carries `hasPlayer`, which the holder sets false the moment its last source disconnects, and a
claim with a player overrides a live lease without one. The old holder watches its lease document
and gives the channel up at once, handing its queue over. Without this, a source that reconnected
to a different instance (affinity is best effort) would wait out the holder's grace in silence.

**A second browser source on another instance does not take over** from one that has a player.
Only the owner's source plays; the other is logged once as `PLAYER_ON_NON_OWNER`. Before, each
clip went to whichever instance won its Pub/Sub claim, so both played a random share.

## What it does not do

- **One channel's work stays on one instance.** Ownership spreads channels, not the load within a
  channel; a burst of chat on one channel is handled by its owner alone, as before.
- **Channels are not rebalanced.** A channel stays with the instance its source is attached to.
- **A handover loses what cannot be serialised:** the clip playing or being generated at that
  moment (its audio was bound for the old instance's socket), prefetched audio for queued clips
  (regenerated on the new owner), redemptions held for approval, the redemption echo guard,
  chat fragments waiting for their redemption, and shared-chat sessions until Twitch sends the
  next `shared_chat.update`. Recent YouTube chatters are unaffected: every instance sees every
  YouTube message.
- **A webhook forwarded just as its owner lets go** waits in the inbox for the next owner and is
  dropped if that takes longer than the age limits above.
- **YouTube chat is unchanged.** The proxy broadcasts to every instance and `dispatchYouTubeTtsEvent`
  claims each message once; the owner, holding the browser source, wins that claim.
- **Shared chat still cannot reach a participant whose browser source is on another instance**
  (`SHARED_CHAT_PARTICIPANT_UNREACHABLE`).

## Switching it on and off

`CHANNEL_OWNERSHIP_ENABLED` (`config.cluster.channelOwnershipEnabled`) defaults to on under Cloud
Run and off everywhere else, so a local process sharing the production Firestore never takes a
channel away from production. Off, every ownership check says this process owns every channel,
nothing is written to `channelLeases` or `channelInbox`, and the old startup restore and
shutdown persistence run.

## Firestore setup

The code compares `expiresAt` itself and never waits for Firestore to delete anything, but both
collections leave documents behind when an instance dies. TTL policies reap them:

```bash
gcloud firestore fields ttls update expiresAt --collection-group=channelLeases --enable-ttl --project=chatvibestts
gcloud firestore fields ttls update expiresAt --collection-group=inboxEvents --enable-ttl --project=chatvibestts
```

**Cost** is a lease write every 10s per channel with a browser source attached (about 8,600 a day
each, plus a read by the owner's watcher), one lease read per webhook that lands off-owner, and a
write, read and delete per forwarded webhook.
