import React, { Suspense } from "react";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getQueryClient } from "@/lib/query-client";
import TournamentsOverviewClient from "@/components/TournamentsOverviewClient";
import prisma from "@/lib/prisma";
import { getTournamentStage } from "@/lib/tournament-stage";
import { getTranslations } from "next-intl/server";
import { RouteLoadingState } from "@/components/RouteStates";

export default async function TournamentsOverview() {
  const t = await getTranslations("directory");
  const queryClient = getQueryClient();

  // Prefetch the initial tournament list
  await queryClient.prefetchQuery({
    queryKey: ['tournaments'],
    queryFn: async () => {
      // Direct prisma fetch for the server-side prefetch. This has to mirror
      // GET /api/tournaments (the client refetches under the same query key), so the
      // lifecycle `stage` is derived here the same way the route derives it.
      const rows = await prisma.tournament.findMany({
          orderBy: { createdAt: 'desc' },
          select: {
              id: true,
              name: true,
              game: true,
              teamSize: true,
              format: true,
              createdAt: true,
              // The route selects this and returns it, and the stage now depends on it: a
              // tournament with sign-up open is in REGISTRATION however few teams have joined.
              // Missing here, the server-rendered board called every open tournament a draft
              // and then silently corrected itself on the first refetch.
              steamSignupEnabled: true,
              teams: { select: { id: true } },
              matches: { select: { status: true } },
              // The route returns `_count`, and the directory card prints the team count from
              // it. Without it here the hydrated board said "0 teams" for every tournament
              // until something invalidated the query — a wrong number, not a missing one.
              _count: { select: { teams: true, matches: true } },
          }
      });
      const tournaments = rows.map(({ teams, matches, ...tournament }) => ({
          ...tournament,
          stage: getTournamentStage(teams, matches, tournament.steamSignupEnabled),
      }));
      return { tournaments };
    }
  });

  return (
    <Suspense fallback={<RouteLoadingState label={t("loadingLabel")} />}>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <TournamentsOverviewClient />
      </HydrationBoundary>
    </Suspense>
  );
}
