# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm install

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client for the target platform
RUN npx prisma generate

ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="file:./dev.db"
RUN npm run build

# Stage 3: the gateway bot — its own tiny tree. No Next, no Prisma, no database, no ./data mount.
#
# NOTE ON ORDER: this stage sits BEFORE the runner on purpose. A Dockerfile's default build
# target is its LAST stage, and `docker-compose.prod.yml` builds the app with a bare
# `build: .` — put this at the bottom and `up -d --build summit` silently ships the bot as
# the app. Keep `runner` last.
#
# Not `FROM builder` (that does COPY . . + `npm run build`, so fixing a Discord typo at 01:00
# would rebuild Next on the box running the tournament) and not the runner image with a
# different command (it contains no discord.js — nothing in src/ imports it, so Next's tracer
# never traces it — so `command: node bot` would crashloop on first boot, discovered at the LAN).
FROM node:22-alpine AS bot
WORKDIR /app

# So TZ=Europe/Oslo actually resolves; without tzdata alpine silently serves UTC.
RUN apk add --no-cache tzdata
ENV NODE_ENV=production
ENV TZ=Europe/Oslo

# bot/package.json holds discord.js and nothing else. Its optional native performance deps
# (zlib-sync, erlpack, bufferutil, utf-8-validate) are deliberately NOT installed, which is
# what removes the apk add python3/make/g++ build step entirely.
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev

COPY bot/ ./

# uid 1000 in node:22-alpine, matching the `user: "1000:1000"` the compose file pins.
USER node

# Health only (/healthz, /status). Not published; the app reads it over the compose network.
EXPOSE 4002

CMD ["node", "index.js"]

# Stage 4: Production runner (MUST stay the last stage — see the note above)
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built assets
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma schema and generated client
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/sharp ./node_modules/sharp

# Bake the Prisma CLI (pinned to the exact version in package-lock.json) into the image so
# `migrate deploy` at boot needs no network and no version drift. Installing globally as root
# also fetches prisma's own alpine engines (linux-musl-openssl-3.0.x) at BUILD time; the tree
# under /usr/local is world-readable/executable, so the non-root runtime user (compose runs us
# as uid 1000) can invoke it. Bump this in lockstep with the `prisma` devDependency.
RUN npm install -g prisma@6.19.3 \
 && chmod -R a+rX /usr/local/lib/node_modules/prisma \
 && prisma --version

# Data directory for SQLite database and uploads
RUN mkdir -p /app/data /app/public/uploads && chown -R nextjs:nodejs /app/data /app/public

USER nextjs

EXPOSE 4001
ENV PORT=4001
ENV HOSTNAME=0.0.0.0

# Apply migrations with the baked-in CLI (no npx / no network at boot), then start the server.
# An existing pre-migrations DB needs a one-time
# `docker exec summit prisma migrate resolve --applied <baseline> --schema=/app/prisma/schema.prisma`.
CMD ["sh", "-c", "DATABASE_URL=file:/app/data/prod.db prisma migrate deploy --schema=/app/prisma/schema.prisma && DATABASE_URL=file:/app/data/prod.db node server.js"]
