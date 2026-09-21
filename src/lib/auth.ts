import SteamProvider from "next-auth-steam";
import DiscordProvider from "next-auth/providers/discord";
import CredentialsProvider from "next-auth/providers/credentials";
import prisma from "@/lib/prisma";
import { backfillPlayersForUser } from "@/lib/player-identity";
import { type NextAuthOptions } from "next-auth";
import { type NextRequest } from "next/server";
import { getRoleForSteamId } from "@/lib/admin-config";

export const getAuthOptions = (req: NextRequest | undefined): NextAuthOptions => ({
  session: {
    strategy: "jwt",
  },
  providers: [
    SteamProvider(req as any, {
      clientSecret: process.env.STEAM_API_KEY!,
      callbackUrl: `${process.env.NEXTAUTH_URL}/api/auth/callback`,
    }),
    DiscordProvider({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
    ...(process.env.MOCK_AUTH_MODE === "true"
      ? [
          CredentialsProvider({
            id: "mock-user",
            name: "Mock User",
            credentials: {
              persona: { label: "Persona", type: "text" },
            },
            async authorize(credentials) {
              const persona = credentials?.persona?.trim().toLowerCase();
              const mockUsers: Record<
                string,
                { email: string; name: string; steamId: string; image?: string | null }
              > = {
                marcus: {
                  email: "mock+marcus@summit.local",
                  name: "Marcus",
                  steamId: "76561198000000001",
                },
                leo: {
                  email: "mock+leo@summit.local",
                  name: "Leo",
                  steamId: "76561198000000002",
                },
                sam: {
                  email: "mock+sam@summit.local",
                  name: "Sam",
                  steamId: "76561198000000003",
                },
                chloe: {
                  email: "mock+chloe@summit.local",
                  name: "Chloe",
                  steamId: "76561198000000004",
                },
                toby: {
                  email: "mock+toby@summit.local",
                  name: "Toby",
                  steamId: "76561198000000005",
                },
              };

              if (!persona || !mockUsers[persona]) {
                return null;
              }

              const profile = mockUsers[persona];
              const user = await prisma.user.upsert({
                where: { email: profile.email },
                update: {
                  name: profile.name,
                  steamId: profile.steamId,
                  image: profile.image || null,
                },
                create: {
                  email: profile.email,
                  name: profile.name,
                  steamId: profile.steamId,
                  image: profile.image || null,
                },
              });

              return {
                id: user.id,
                email: user.email,
                name: user.name,
                image: user.image,
                steamId: user.steamId,
              } as any;
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ user, account }: any) {
      if (account?.provider === "steam" && account.providerAccountId) {
        try {
          const steamId = account.providerAccountId;
          const dbUser = await prisma.user.upsert({
            where: { steamId: steamId },
            update: {
              name: user.name,
              image: user.image,
            },
            create: {
              name: user.name,
              image: user.image,
              steamId: steamId,
            },
          });
          // A player an organizer typed in before this account ever signed in is orphaned:
          // it has a steamId but no userId, so nothing can reach them. Adopt those rows now.
          await backfillPlayersForUser(dbUser.id, steamId).catch((e) =>
            console.warn("[auth] player back-fill failed:", e?.message)
          );
          return true;
        } catch (error) {
          console.error("Error during Steam signIn manual sync:", error);
          return true;
        }
      }

      if (account?.provider === "discord" && account.providerAccountId) {
        try {
          const discordId = account.providerAccountId;
          // Linking to existing user by email if possible
          if (user.email) {
            await prisma.user.update({
              where: { email: user.email },
              data: {
                image: user.image,
                name: user.name,
              }
            });
          }
          // The prisma adapter (if we used one) would handle Account creation, 
          // but since we are using JWT and manual sync, we'll rely on the default NextAuth behavior 
          // for the 'Account' table if the user is already logged in, 
          // or we just let it create a session.
          return true;
        } catch (error) {
          console.error("Error during Discord signIn sync:", error);
          return true;
        }
      }
      return true;
    },
    async jwt({ token, user, account }: any) {
      if (account?.provider === "steam") {
        token.steamId = account.providerAccountId;
      }
      if (account?.provider === "discord") {
        token.discordId = account.providerAccountId;
      }
      if (account?.provider === "mock-user" && user) {
        token.dbId = user.id;
        token.steamId = (user as any).steamId;
      }

      if (user) {
        let dbUser = null;
        if (token.steamId) {
          dbUser = await prisma.user.findUnique({ where: { steamId: token.steamId as string } });
        } else if (user.email) {
          dbUser = await prisma.user.findUnique({ where: { email: user.email } });
        }
        
        if (dbUser) {
          token.dbId = dbUser.id;
        }
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        (session.user as any).id = token.dbId;
        (session.user as any).steamId = token.steamId;
        (session.user as any).discordId = token.discordId;
        // Role drives the shared header's nav (Admin/Marshal links) on the client.
        (session.user as any).role = getRoleForSteamId(token.steamId);
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NEXTAUTH_DEBUG === "true",
});
