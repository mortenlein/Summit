'use client';

import { useSession, signIn, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Gamepad2, Loader2, ShieldCheck, Zap } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '@/components/ui';
import { MockPersonaButtons } from '@/components/MockPersonaButtons';
import { SeatEditor } from '@/components/player/SeatEditor';
import { StateChip, useMyQueue } from '@/components/player/MyQueue';
import { DiscordLinkCard } from '@/components/player/DiscordLinkCard';

/**
 * /profile — the account, and the one thing a player actually changes on it: their seat in each
 * tournament they're registered for. Anything this page cannot back with data (a settings screen
 * that doesn't exist) is deliberately not here.
 *
 * The Discord card is the one exception to the old "no second linked account" rule, and only
 * because it is now backed by a table and by delivery: it is where these players already are.
 * It self-hides when the integration is unconfigured, so it is never a dead offer.
 */
export default function ProfilePage() {
    const t = useTranslations('player');
    const tCommon = useTranslations('common');
    const { data: session, status } = useSession();
    const queryClient = useQueryClient();

    const { data: profile, isLoading } = useQuery({
        queryKey: ['profile'],
        queryFn: async () => {
            const res = await fetch('/api/user/profile?view=profile');
            if (!res.ok) throw new Error('Failed to fetch profile');
            return res.json();
        },
        enabled: status === 'authenticated',
        staleTime: 60_000,
    });

    // The queue, not the profile payload: `view=profile` skips `activeMatches` entirely, so the
    // counter this replaces was structurally unable to say "you are being called right now".
    // Above the early return, because hooks cannot sit behind one.
    const { data: queue } = useMyQueue({ enabled: status === 'authenticated' });

    if (status === 'unauthenticated') {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-page p-8 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-brand/20 bg-brand-soft">
                    <ShieldCheck size={34} className="text-brand" />
                </div>
                <div className="max-w-md space-y-3">
                    <h1 className="font-brand text-3xl font-bold tracking-tight">{t('profile.signInTitle')}</h1>
                    <p className="text-fg-muted">{t('profile.signInBody')}</p>
                </div>
                <Button onClick={() => signIn('steam')}>
                    <Zap size={15} />
                    {t('desk.continueWithSteam')}
                </Button>
                <MockPersonaButtons callbackUrl="/profile" />
            </div>
        );
    }

    const loading = status === 'loading' || (status === 'authenticated' && isLoading);
    const { registrations = [] } = profile || {};
    const byTournament = new Map((queue?.queue ?? []).map((e) => [e.tournamentId, e]));

    return (
        <div className="min-h-screen bg-page text-fg">
            <main className="mds-container space-y-6 py-6 sm:py-8">
                <header className="flex flex-wrap items-center gap-4">
                    {/* The tile exists only when there is a picture in it. TopNav already does
                        `image ? <Image/> : null`; this page was the deviation, framing a grey
                        controller glyph in a bordered box. The slot is still reserved while the
                        session resolves, so the name does not slide sideways on hydration. */}
                    {status === 'loading' ? (
                        <div className="h-14 w-14 shrink-0 animate-pulse rounded-lg bg-white/5" />
                    ) : session?.user?.image ? (
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg">
                            <Image
                                src={session.user.image}
                                alt=""
                                width={56}
                                height={56}
                                className="h-full w-full object-cover"
                            />
                        </div>
                    ) : null}
                    {/* A floor, not just flex-1: with `min-w-0` alone this column collapses to a
                        few pixels on a phone whenever the badge and the sign-out button happen to
                        fit beside it, and the player's own name wraps one letter per line. The
                        minimum makes the actions wrap to their own row instead. */}
                    {/* "SPILLERPROFIL" is an aria-label on the section, not a line of type over
                        the kid's own name. The name is guarded, and a shimmer stands in while the
                        session resolves, or cutting the label would leave a grey square over a
                        void on a slow load. */}
                    <div className="min-w-[12rem] flex-1" aria-label={t('profile.label')}>
                        {/* The player's own casing — never shouted back at them. */}
                        {session?.user?.name ? (
                            <h1 className="mds-name-lg text-2xl">{session.user.name}</h1>
                        ) : (
                            <div className="h-8 w-40 animate-pulse rounded-sm bg-white/5" />
                        )}
                    </div>
                </header>

                {/* The one linked account that is now backed by a table. The header comment
                    above is still right about inventing surfaces — this one exists because a
                    DM to Discord is how a player at their PC finds out they have been called. */}
                <DiscordLinkCard />

                {/* A section header over the only section on the page names something the reader
                    is already looking at. The name survives for a screen reader. */}
                <section className="space-y-3" aria-label={t('tournaments.label')}>
                    {loading && registrations.length === 0 && (
                        <Card className="flex items-center gap-3" aria-busy="true">
                            <Loader2 size={16} className="animate-spin text-brand" />
                            <span className="text-sm text-fg-muted">{t('profile.loading')}</span>
                        </Card>
                    )}

                    {!loading && registrations.length === 0 && (
                        <EmptyState
                            icon={<Gamepad2 size={26} />}
                            title={t('profile.emptyTitle')}
                            description={t('profile.emptyBody')}
                            action={
                                <Link href="/tournaments">
                                    <Button>{t('action.browseTournaments')}</Button>
                                </Link>
                            }
                        />
                    )}

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {registrations.map((reg: any) => (
                            // Not one big link: the seat editor inside is interactive, and a button
                            // nested in an anchor is invalid markup and a click trap.
                            <Card key={reg.id} className="space-y-3">
                                <div className="flex items-start justify-between gap-3">
                                    <Link
                                        href={`/tournaments/${reg.team.tournament.id}`}
                                        className="group flex min-w-0 items-start gap-2"
                                    >
                                        <h2 className="mds-name-lg text-lg group-hover:text-brand">
                                            {reg.team.tournament.name}
                                        </h2>
                                        <ArrowRight
                                            size={15}
                                            className="mt-1.5 shrink-0 text-fg-subtle group-hover:text-brand"
                                        />
                                    </Link>
                                    {/* What the queue actually says about this tournament, not a
                                        count that rendered "being called right now" and "three
                                        rounds away" as the same number. */}
                                    <StateChip entry={byTournament.get(reg.team.tournament.id)} />
                                </div>
                                <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
                                    <div className="min-w-0">
                                        <p className="mds-uppercase-label text-fg-subtle">{tCommon('team')}</p>
                                        <p className="mds-name mt-1 text-sm">
                                            {reg.team.name}
                                            {/* nowrap: "(lagleder)" is long enough to land on the
                                                wrap point after a team name, and the name style
                                                hyphenates — it broke as "(lagle- der)" on a phone. */}
                                            {reg.isLeader && (
                                                <span className="ml-1 whitespace-nowrap text-xs text-fg-subtle">
                                                    {t('profile.leaderSuffix')}
                                                </span>
                                            )}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="mds-uppercase-label text-fg-subtle">{t('seat.label')}</p>
                                        <SeatEditor
                                            className="mt-1"
                                            tournamentId={reg.team.tournament.id}
                                            seating={reg.seating}
                                            onSaved={() => queryClient.invalidateQueries({ queryKey: ['profile'] })}
                                        />
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                </section>

                {/* Sign-out at the bottom, ghost weight, no icon. It was a bordered secondary
                    button in the header, rendering heavier than the seat code — which is the
                    highest-value string on this page and the one a kid actually came for.
                    Nobody opens their profile to sign out. (Safe to demote only now: the header
                    keeps its own sign-out from `md` up, and the drawer holds it below that.) */}
                <div className="flex justify-end pt-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={async () => {
                            try {
                                await fetch('/api/auth/logout', { method: 'POST' });
                            } catch {
                                // Best effort admin-cookie cleanup before NextAuth sign-out.
                            }
                            await signOut({ callbackUrl: '/' });
                        }}
                    >
                        {tCommon('signOut')}
                    </Button>
                </div>
            </main>
        </div>
    );
}
