-- "Up next" must post once per match, ever, and a failed webhook must not spend that one chance.
--
-- dedupeKey  : the atomic claim for a once-only announcement. NULL on every ordinary row, and
--              SQLite treats NULLs as distinct in a unique index, so ordinary rows never collide.
-- deliveredAt: NULL means logged but not delivered — a retryable state, which is why it is a
--              timestamp and not a boolean.
ALTER TABLE "NotificationLog" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "NotificationLog" ADD COLUMN "deliveredAt" DATETIME;

CREATE UNIQUE INDEX "NotificationLog_dedupeKey_key" ON "NotificationLog"("dedupeKey");

-- Rows written before this migration were delivered (or mock-delivered) at the moment they were
-- logged; the old code logged only on that path. Stamping them keeps an existing tournament's
-- feed from re-posting its whole history the first time the queue moves after a deploy.
UPDATE "NotificationLog" SET "deliveredAt" = "createdAt" WHERE "deliveredAt" IS NULL;
