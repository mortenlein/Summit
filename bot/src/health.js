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

/** Gateway states that mean "the process is doing its job or trying to". */
const LIVE_STATES = new Set(['ready', 'reconnecting']);

export function isLive(state) {
  return LIVE_STATES.has(state);
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
      const live = isLive(status.state);
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
    listen: (port, host) =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export default createHealthServer;
