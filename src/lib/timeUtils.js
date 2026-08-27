export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout, without leaving the timer behind.
 *
 * The naive form — `Promise.race([work, new Promise((_, r) => setTimeout(r, ms))])`
 * — keeps an unfired timer on the event loop for the full timeout after the work
 * finishes. A long-lived server only pays a delayed shutdown for that, but a
 * short-lived script appears to hang for the whole duration once its real work
 * is done.
 *
 * Losing the race does not cancel the underlying work; it only stops us waiting.
 * A late rejection from the loser needs no special handling, because Promise.race
 * has already attached a handler to it.
 *
 * @param {Promise} promise Work to bound.
 * @param {number} ms       Timeout in milliseconds.
 * @param {string} message  Error message when the timeout wins.
 */
export function withTimeout(promise, ms, message = 'Operation timed out') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
