// src/lib/instanceId.js
// Identity of this running process, for telemetry that has to tell containers apart.
//
// K_REVISION on its own is not enough. Cloud Run sets it to the *revision* name, so
// every container serving that revision reports the same value — and Cloud Run runs
// many containers per revision. Any check of the form "did this channel appear under
// more than one instance?" therefore answers "no" no matter how many containers were
// involved, which is exactly backwards for the cross-instance audio loss it is meant
// to detect. Cloud Run exposes no per-container id as an environment variable, so one
// is minted here at startup instead.

import crypto from 'crypto';

/** The Cloud Run revision, or 'local' outside Cloud Run. Shared by every container of a deploy. */
export const REVISION = process.env.K_REVISION || 'local';

/**
 * Unique to this process. Stable for its lifetime, different in every container —
 * including two containers of the same revision, which is the case REVISION misses.
 * Keeps the revision as a prefix so a log line still says which deploy it came from.
 */
export const INSTANCE_ID = `${REVISION}-${crypto.randomBytes(4).toString('hex')}`;
