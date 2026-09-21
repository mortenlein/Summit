-- CreateTable
CREATE TABLE "DiscordLink" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "discordId" TEXT NOT NULL,
    "discordUsername" TEXT NOT NULL,
    "dmChannelId" TEXT,
    "dmState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "dmCheckedAt" DATETIME,
    "dmError" TEXT,
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscordLinkCode" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscordDmAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "matchId" TEXT,
    "outcome" TEXT NOT NULL,
    "discordCode" INTEGER,
    "locale" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordDmAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Tournament" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "game" TEXT NOT NULL DEFAULT 'CS2',
    "category" TEXT NOT NULL DEFAULT 'BRACKET',
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'SINGLE_ELIMINATION',
    "teamSize" INTEGER NOT NULL DEFAULT 5,
    "bo3LastRounds" INTEGER,
    "bo5LastRounds" INTEGER,
    "hasThirdPlace" BOOLEAN NOT NULL DEFAULT false,
    "steamSignupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "eonBridgeToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rosterLocked" BOOLEAN NOT NULL DEFAULT false,
    "discordDmPaused" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_Tournament" ("bo3LastRounds", "bo5LastRounds", "category", "createdAt", "eonBridgeToken", "format", "game", "hasThirdPlace", "id", "name", "rosterLocked", "steamSignupEnabled", "teamSize", "type", "updatedAt") SELECT "bo3LastRounds", "bo5LastRounds", "category", "createdAt", "eonBridgeToken", "format", "game", "hasThirdPlace", "id", "name", "rosterLocked", "steamSignupEnabled", "teamSize", "type", "updatedAt" FROM "Tournament";
DROP TABLE "Tournament";
ALTER TABLE "new_Tournament" RENAME TO "Tournament";
CREATE UNIQUE INDEX "Tournament_eonBridgeToken_key" ON "Tournament"("eonBridgeToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "DiscordLink_discordId_key" ON "DiscordLink"("discordId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordLinkCode_userId_key" ON "DiscordLinkCode"("userId");

-- CreateIndex
CREATE INDEX "DiscordDmAttempt_matchId_idx" ON "DiscordDmAttempt"("matchId");

-- CreateIndex
CREATE INDEX "DiscordDmAttempt_createdAt_idx" ON "DiscordDmAttempt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordDmAttempt_matchId_event_userId_key" ON "DiscordDmAttempt"("matchId", "event", "userId");
