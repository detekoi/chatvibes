# EventSub duplicate subscriptions (`PUBLIC_URL`)

Twitch keys subscription identity on type + condition + **transport callback**. Cloud Run answers
this service on two hostnames — `chatvibes-tts-service-906125386407.us-central1.run.app` (the
deployed `PUBLIC_URL`) and `chatvibes-tts-service-h7kj56ct4q-uc.a.run.app` (the hash form that
`gcloud run services list` prints) — so the same subscription registered under each is two
subscriptions as far as Twitch is concerned.

**Neither existing guard catches that.** The 409 "already exists" handling in `twitchSubs.js`
never fires, because the two are not identical to Twitch. The idempotency check in `eventsub.js`
does not either: it keys on `twitch-eventsub-message-id`, which Twitch assigns *per delivery*, so
each copy arrives with its own id and both pass.

The symptom is every chat message spoken twice and audio drifting further behind chat as the
doubled queue drains at half speed. It reads as a TTS or queue bug, which is the wrong place to
look. **Set `PUBLIC_URL` in a local `.env` to the deployed value before running any subscribe
script**, or the run silently doubles every channel it touches.

A second, unrelated path to the same symptom is a race: two concurrent subscribe calls can both
create a subscription before either sees a 409, producing two identical subs on the *same*
callback (observed milliseconds apart). The `activeSubscriptionRequests` in-flight guard is
per-instance and does not span Cloud Run instances.

`scripts/verify-channel-subscriptions.js` detects both, plus callback drift, and exits non-zero.
It counts subscriptions rather than collapsing them into a set of type names — the set is what hid
the original occurrence. `scripts/cleanup-eventsub.js` deletes strays on the legacy hostname.
When removing a duplicate, confirm the surviving copy exists first or you drop coverage.
