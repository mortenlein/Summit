/**
 * Line logger. One line, one fact, prefixed with a level and an ISO timestamp in TZ.
 *
 * `docker logs summit-bot` is read at 01:00 by someone who is not a developer, so the lines
 * have to be greppable and must never contain a token, a bearer key or a link code.
 */

const REDACTIONS = [
  process.env.DISCORD_BOT_TOKEN,
  process.env.SUMMIT_BOT_KEY,
].filter((v) => typeof v === 'string' && v.length >= 8);

/** Replace any known secret that slipped into a message with `***`. */
export function redact(text, secrets = REDACTIONS) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('***');
  }
  return out;
}

function emit(stream, level, message, fields) {
  const parts = [`[${new Date().toISOString()}]`, `[${level}]`, redact(message)];
  if (fields && Object.keys(fields).length > 0) {
    const pairs = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${redact(typeof v === 'string' ? v : JSON.stringify(v))}`);
    if (pairs.length) parts.push(pairs.join(' '));
  }
  stream(parts.join(' '));
}

export const logger = {
  info: (message, fields) => emit((l) => console.log(l), 'bot', message, fields),
  warn: (message, fields) => emit((l) => console.warn(l), 'bot:warn', message, fields),
  error: (message, fields) => emit((l) => console.error(l), 'bot:error', message, fields),
};

export default logger;
