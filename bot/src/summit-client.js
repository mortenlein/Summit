/**
 * The bot → app transport. There is no app → bot direction.
 *
 * Two POSTs, a bearer key, an 8-second abort, and a promise that nothing here ever throws:
 * an unhandled rejection inside an interaction handler shows the kid a red "The application
 * did not respond" for a link that may well have succeeded.
 */

/**
 * @param {object} options
 * @param {string} options.baseUrl        e.g. http://summit:4001 (compose network, never the tunnel)
 * @param {string} options.botKey         SUMMIT_BOT_KEY — sent as `Authorization: Bearer …`
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]  injected in tests
 * @param {() => number} [options.now]
 */
export function createSummitClient({ baseUrl, botKey, timeoutMs = 8000, fetchImpl = fetch, now = Date.now }) {
  /** Surfaced on /status; never contains the key or a link code. */
  const stats = { lastOkAt: null, lastErrorAt: null, lastError: null, calls: 0, refusedNoKey: 0 };

  // Fail closed, here as well as in readConfig(). `SUMMIT_BOT_KEY` is a REQUIRED var and a
  // missing one already stops the boot, but the client must not be constructible into a state
  // where it sends an anonymous or malformed POST: `Bearer ` with no key is a request the app
  // is obliged to reject, and a key with a stray newline makes Node throw an opaque
  // "invalid header value" from inside fetch, which the interaction handler would then show
  // the player as "Summit isn't responding". Neither should ever leave this process.
  const key = String(botKey ?? '');
  const keyUsable = key.trim().length > 0 && !/[^\t\x20-\x7e]/.test(key);

  async function post(path, payload) {
    stats.calls += 1;
    if (!keyUsable) {
      stats.refusedNoKey += 1;
      stats.lastErrorAt = now();
      stats.lastError = `${path}: refused — SUMMIT_BOT_KEY is missing or not header-safe`;
      return { ok: false, status: 0, body: null, error: 'no bot key' };
    }
    const url = `${baseUrl}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'user-agent': 'summit-bot',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network error, DNS failure, or our own abort. All the same to the caller: the app
      // could not be reached, so the bot shows its fallback.
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : String(error?.message || error);
      stats.lastErrorAt = now();
      stats.lastError = `${path}: ${reason}`;
      return { ok: false, status: 0, body: null, error: reason };
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null; // A 502 from a restarting app is HTML, not JSON. Not an exception.
    }

    if (!response.ok) {
      stats.lastErrorAt = now();
      stats.lastError = `${path}: HTTP ${response.status}`;
      return { ok: false, status: response.status, body, error: `HTTP ${response.status}` };
    }

    stats.lastOkAt = now();
    return { ok: true, status: response.status, body, error: null };
  }

  return {
    stats,
    /** @param {{ code: string, discordId: string, discordUsername: string, locale?: string }} payload */
    postLink: (payload) => post('/api/discord/link', payload),
    /** @param {{ discordId: string, locale?: string }} payload */
    postOptOut: (payload) => post('/api/discord/optout', payload),
  };
}

export default createSummitClient;
