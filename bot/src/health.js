/**
 * Liveness split from readiness (docs/discord-bot-spec.md §10).
 *
 *   GET /healthz  — is this process alive, and is the gateway READY or reconnecting?
 *                   That and ONLY that. It must not depend on the app being up: otherwise
 *                   every `up -d --build summit` flips the bot unhealthy, and server-vakt
 *                   pushes an ntfy alert on first sighting, teaching the organizer to swipe
 *                   Summit alerts away before the LAN.
 *   GET /status   — the richer picture for a human and for the in-app chip.
 *
 * Bound to 0.0.0.0 inside the container: a loopback-only listener passes the HEALTHCHECK
 * while every other reader fails.
 */

import http from 'node:http';

/**
 * Liveness, and its one deliberate bound.
 *
 *   `ready`        — connected. Live.
 *   `reconnecting` — discord.js is retrying, and a blip must NOT flip the container unhealthy
 *                    (server-vakt alerts on first sighting, and two weeks of spurious ntfy
 *                    pushes teach the organizer to swipe Summit alerts away before the LAN).
 *                    But it is live only for as long as a reconnect plausibly takes. A bot
 *                    that has been reconnecting for ten minutes is not doing its job, and a
 *                    /healthz that answers `ok` forever while nobody can run /koble is the
 *                    same class of lie as a UI claiming a player was notified. After the
 *                    grace window it reports the truth and the watchdog gets to say so.
 *   anything else  — not live.
 *
 * This bound is on the *gateway* only. It is still independent of whether the app is
 * reachable: rebuilding `summit` never changes this answer.
 *
 * @param {string} state
 * @param {{ since?: number|null, graceMs?: number, now?: number }} [options]
 *   `since` is when the process entered `state` (epoch ms).
 */
export function isLive(state, { since = null, graceMs = 300000, now = Date.now() } = {}) {
  if (state === 'ready') return true;
  if (state !== 'reconnecting') return false;
  if (!Number.isFinite(since)) return true; // no clock to judge by — do not invent a failure
  return now - since < graceMs;
}

/**
 * @param {object} options
 * @param {() => object} options.getStatus  returns the full status object (no secrets in it)
 * @param {object} [options.logger]
 */
export function createHealthServer({ getStatus, logger = console }) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const status = getStatus();

    if (url === '/healthz') {
      const live = isLive(status.state, {
        since: Date.parse(status.stateSince ?? '') || null,
        graceMs: status.reconnectGraceMs,
      });
      res.writeHead(live ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${live ? 'ok' : 'not-ready'} ${status.state}\n`);
      return;
    }

    if (url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });

  server.on('error', (error) => {
    logger.error?.('health server error', { message: String(error?.message || error) });
  });

  return {
    server,
    /**
     * Rejects on a bind failure. Resolving-or-hanging would leave `main()` awaiting forever
     * on a taken port: no gateway connection, no further log lines, and nothing to read but a
     * failing HEALTHCHECK. The caller turns this into a named fatal instead.
     */
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export default createHealthServer;
