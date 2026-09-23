'use client';

import { useState, useEffect, useCallback, use } from 'react';
import { useSession, signIn, signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    AlertCircle,
    ArrowRight,
    Check,
    CheckCircle2,
    Copy,
    Crown,
    Gamepad2,
    Loader2,
    Lock,
    LogOut,
    ShieldCheck,
    Upload,
    Users,
} from 'lucide-react';
import { Badge, Button, Card, Input } from '@/components/ui';
import { MockPersonaButtons } from '@/components/MockPersonaButtons';
import { useToast } from '@/components/ToastProvider';
import { RouteNotFoundState } from '@/components/RouteStates';
import { SeatEditor, SEAT_MAX_LENGTH } from '@/components/player/SeatEditor';
import { clientApi } from '@/lib/client-api';
import { useApiErrorMessage } from '@/i18n/error-message';
import { getGameMetadata } from '@/lib/games';
import { formatName } from '@/components/tournament/match-labels';

/**
 * The one-line verdict on a typed Discord name.
 *
 * Deliberately not a toast: a toast is gone before a 13-year-old has finished reading it, and
 * three of these five outcomes need them to do something.
 */
function DiscordOutcome({ result }: { result: any }) {
    const t = useTranslations('register');

    if (result?.ok && result.dmState === 'BLOCKED') {
        return (
            <div className="mds-inline-notice border-l-warning text-sm">
                <p className="m-0 font-semibold text-fg">{t('discordBlockedTitle')}</p>
                <p className="m-0 mt-0.5 text-fg-muted">{t('discordBlockedBody')}</p>
            </div>
        );
    }
    if (result?.ok) {
        return (
            <div className="mds-inline-notice border-l-success text-sm">
                <p className="m-0 font-semibold text-fg">
                    {t('discordFoundTitle', { name: result.discordUsername })}
                </p>
                <p className="m-0 mt-0.5 text-fg-muted">{t('discordFoundBody')}</p>
            </div>
        );
    }

    const REASON: Record<string, string> = {
        not_found: 'discordNotFound',
        ambiguous: 'discordAmbiguous',
        discord_taken: 'discordTaken',
    };
    return (
        <div className="mds-inline-notice border-l-warning text-sm text-fg-muted">
            {t(REASON[result?.reason] ?? 'discordFailed')}
        </div>
    );
}

/**
 * The shell every state of this page sits in: the tournament it is about, then one panel.
 *
 * `showMeta` is false on the branches where the kid already has a team. There their questions
 * are seat, roster and invite link; format and team size are not actionable once you are in.
 */
function RegisterShell({
    tournament,
    showMeta = true,
    children,
}: {
    tournament?: any;
    showMeta?: boolean;
    children: React.ReactNode;
}) {
    const t = useTranslations('register');
    const tStage = useTranslations('stage');

    return (
        <div className="min-h-screen bg-page text-fg">
            <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-8 sm:px-6 sm:py-12">
                {tournament && (
                    // No "PÅMELDING" label: the page a kid tapped "meld på" to reach does not
                    // need to announce itself, and on the closed branch it sat directly above
                    // the heading "Påmeldingen er stengt", saying the same word twice.
                    <header className="space-y-2 pt-1">
                        {/* The organiser's own casing — a tournament name is content, not a label. */}
                        <h1 className="mds-name-lg text-2xl sm:text-3xl">{tournament.name}</h1>
                        {showMeta && (
                            <>
                                {/* Game and format are context, not instructions: one muted line,
                                    not two badges competing with the one badge that IS an
                                    instruction. Both used to render raw: the enum `CS2` and the
                                    hardcoded English "Single Elimination". */}
                                <p className="text-sm text-fg-muted">
                                    {getGameMetadata(tournament.game)?.name || tournament.game}
                                    {formatName(tournament.format, tStage)
                                        ? ` · ${formatName(tournament.format, tStage)}`
                                        : ''}
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                    {/* Team size stays a badge. "5 per lag" is the one thing here
                                        a kid acts on: go and find four more people. */}
                                    <Badge tone="neutral">
                                        {t.rich('perTeam', {
                                            count: tournament.teamSize,
                                            n: (chunks) => <span className="mds-numeric">{chunks}</span>,
                                        })}
                                    </Badge>
                                </div>
                            </>
                        )}
                    </header>
                )}
                {children}
            </main>
        </div>
    );
}

function ErrorNotice({ message }: { message: string }) {
    return (
        <div
            role="alert"
            data-testid="register-error"
            className="flex items-start gap-3 rounded border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{message}</span>
        </div>
    );
}

/**
 * `initialTournament` is the same payload this component fetches for itself, prefetched on the
 * server by page.tsx.
 *
 * It exists for one frame: without it, the first paint of the page a kid taps "meld på" to reach
 * was a bordered box with a spinner over a screen of black, and the tournament's name — the one
 * thing that confirms they are in the right place — arrived a round-trip later. Seeded here,
 * the header is on the first frame and only the form area waits. The client fetch still runs and
 * still wins; `getTournament` mirrors GET /api/tournaments/[id] field for field, staff redaction
 * included, so the two never disagree about shape.
 */
export default function RegisterClient(props: {
    params: Promise<{ id: string }>;
    initialTournament?: any;
    /** Whether this deployment can actually resolve and DM a Discord name. */
    discordConfigured?: boolean;
}) {
    const params = use(props.params);
    const t = useTranslations('register');
    // The seat vocabulary is the player desk's, not this page's: one wording for "your seat"
    // and its helper line, wherever a player types it.
    const tPlayer = useTranslations('player');
    const { data: session, status } = useSession();
    const router = useRouter();
    const searchParams = useSearchParams();
    const inviteCode = searchParams.get('invite');
    const toast = useToast();
    const apiErrorMessage = useApiErrorMessage();

    const [tournament, setTournament] = useState<any>(props.initialTournament ?? null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<'link' | 'code' | null>(null);
    // Optional LAN seat the player types while signing up, sent along with the signup POST.
    const [seating, setSeating] = useState('');
    /** The Discord name the player types on this form. Resolved server-side against the club's
     *  own server, so what we keep is the account, never the string. */
    const [discordName, setDiscordName] = useState('');
    /** What the server made of it, so the confirmation can say so instead of going quiet. */
    const [discordResult, setDiscordResult] = useState<any>(null);

    const [teamData, setTeamData] = useState({
        name: '',
        logoUrl: '',
        players: [] as any[],
    });
    const [logoFile, setLogoFile] = useState<File | null>(null);
    const [logoPreview, setLogoPreview] = useState<string | null>(null);
    /** The logo field is opt-in — see the disclosure in the create-team form. */
    const [showLogoField, setShowLogoField] = useState(false);
    const [userTeam, setUserTeam] = useState<any>(null);
    const sessionSteamId = (session?.user as any)?.steamId as string | undefined;
    const isSignedIn = Boolean(session?.user);
    // Steam-signup tournaments additionally need a Steam-linked account (invite links key off it).
    const requiresSteamAuth = Boolean(tournament?.steamSignupEnabled) && (!isSignedIn || !sessionSteamId);
    // Every registration is now tied to a user account — anonymous sign-up is gone.
    const requiresSignIn = !isSignedIn || requiresSteamAuth;
    const callbackUrl = `/tournaments/${params.id}/register${inviteCode ? `?invite=${inviteCode}` : ''}`;

    /**
     * Pulls the viewer's own team out of the teams endpoint. That endpoint marks the viewer's
     * own player rows with isMe (and only then exposes that team's invite code), so it is the
     * canonical shape for the team panel — richer than the signup POST response.
     */
    const loadMyTeam = useCallback(async () => {
        try {
            const teams = await clientApi.getTeams(params.id);
            const myTeam = Array.isArray(teams)
                ? teams.find((t: any) => t.players?.some((p: any) => p.isMe))
                : undefined;
            if (myTeam) setUserTeam(myTeam);
            return myTeam ?? null;
        } catch {
            return null;
        }
    }, [params.id]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const res = await fetch(`/api/tournaments/${params.id}`);
                const current = await res.json();
                if (res.ok) {
                    setTournament(current);
                    setTeamData((prev) => ({
                        ...prev,
                        players: Array(current.teamSize || 5).fill({ name: '', nickname: '', countryCode: 'no', steamId: '' }),
                    }));
                } else {
                    setError(t('errorNotFound'));
                }

                if (session && sessionSteamId && current.steamSignupEnabled) {
                    await loadMyTeam();
                }
            } catch (err) {
                setError(t('errorLoadFailed'));
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [params.id, session, sessionSteamId, loadMyTeam, t]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        setError(null);

        try {
            let logoUrl = teamData.logoUrl;
            if (logoFile) {
                const uploadData = new FormData();
                uploadData.append('file', logoFile);
                const uploadRes = await fetch('/api/upload', { method: 'POST', body: uploadData });
                if (!uploadRes.ok) throw new Error(t('errorLogoUpload'));
                const { url } = await uploadRes.json();
                logoUrl = url;
            }

            if (tournament?.steamSignupEnabled) {
                const res = await fetch(`/api/tournaments/${params.id}/signup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'CREATE_TEAM',
                        teamName: teamData.name,
                        logoUrl,
                        seating,
                        discordUsername: discordName,
                    }),
                });

                if (!res.ok) {
                    const data = await res.json();
                    throw new Error(apiErrorMessage(data, t('errorRegistration')));
                }
                const newTeam = await res.json();
                setUserTeam(newTeam);
                setDiscordResult(newTeam?.discord ?? null);
                // Re-read the roster so the panel gets the isMe/inviteCode shape it renders from.
                await loadMyTeam();
                setSuccess(true);
            } else {
                const cleanedPlayers = teamData.players.filter((p) => p.name.trim() !== '');
                if (cleanedPlayers.length < (tournament?.teamSize || 1)) {
                    throw new Error(t('errorMinPlayers', { count: tournament?.teamSize || 1 }));
                }

                const res = await fetch(`/api/tournaments/${params.id}/teams`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: teamData.name, logoUrl, players: cleanedPlayers }),
                });

                if (!res.ok) {
                    const data = await res.json();
                    throw new Error(apiErrorMessage(data, t('errorRegistration')));
                }
                setSuccess(true);
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    };

    const handleJoinTeam = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/tournaments/${params.id}/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'JOIN_TEAM',
                    inviteCode,
                    seating,
                    discordUsername: discordName,
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(apiErrorMessage(data, t('errorJoin')));
            }
            const joinedTeam = await res.json();
            setUserTeam(joinedTeam);
            setDiscordResult(joinedTeam?.discord ?? null);
            // Re-read the roster so the panel gets the isMe/inviteCode shape it renders from.
            await loadMyTeam();
            setSuccess(true);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    };

    const updatePlayer = (index: number, field: string, value: string) => {
        const newPlayers = [...teamData.players];
        newPlayers[index] = { ...newPlayers[index], [field]: value };
        setTeamData({ ...teamData, players: newPlayers });
    };

    /** Keeps the rendered roster in sync after the inline seat editor saves. */
    const handleSeatSaved = (nextSeating: string | null) => {
        setUserTeam((current: any) =>
            current && {
                ...current,
                players: (current.players || []).map((player: any) =>
                    player.isMe ? { ...player, seating: nextSeating } : player
                ),
            }
        );
    };

    const handleLeaveTeam = async () => {
        if (!window.confirm(t('leaveConfirm'))) return;
        setLeaving(true);
        try {
            const result = await clientApi.leaveMyTeam(params.id);
            setUserTeam(null);
            setSuccess(false);
            setSeating('');
            toast.success(t('leftTitle'), result.teamDeleted ? t('leftDeleted') : undefined);
            router.refresh();
        } catch (err: any) {
            toast.error(t('leaveErrorTitle'), apiErrorMessage(err, t('leaveErrorHint')));
        } finally {
            setLeaving(false);
        }
    };

    const copyText = (text: string, what: 'link' | 'code') => {
        const done = () => {
            setCopied(what);
            window.setTimeout(() => setCopied(null), 2500);
        };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text);
            done();
            return;
        }
        // Fallback for non-HTTPS/LAN environments
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            document.execCommand('copy');
            done();
        } catch (err) {
            console.error('Fallback copy failed', err);
        }
        document.body.removeChild(textArea);
    };

    if (loading || status === 'loading') {
        return (
            <RegisterShell tournament={tournament}>
                {/* A row, not a card. A bordered box drawn around a spinner is a container for
                    nothing, and it was the only shape on the screen while the page loaded. */}
                <div className="flex items-center gap-3" role="status" aria-live="polite">
                    <Loader2 className="animate-spin text-brand" size={18} />
                    <span className="text-sm text-fg-muted">{t('loading')}</span>
                </div>
            </RegisterShell>
        );
    }

    if (!tournament) {
        return (
            <RouteNotFoundState
                title={t('notFoundTitle')}
                description={t('notFoundBody')}
                primaryLabel={t('notFoundBack')}
                primaryHref="/tournaments"
            />
        );
    }

    // A player who is already on a team keeps access to their team panel forever — including
    // after the bracket is generated. Seats change on the LAN floor, and the invite link stays
    // useful right up to lock, so this branch deliberately runs BEFORE the locked notice.
    if (userTeam || success) {
        const players: any[] = userTeam?.players || [];
        const myPlayer = players.find((player) => player.isMe);
        const teamSize = tournament?.teamSize || 1;
        const isFull = players.length >= teamSize;
        const slotsLeft = Math.max(0, teamSize - players.length);
        const registrationLink =
            typeof window !== 'undefined' && userTeam?.inviteCode
                ? `${window.location.origin}/tournaments/${params.id}/register?invite=${userTeam.inviteCode}`
                : '';
        const canInvite = !isFull && tournament.steamSignupEnabled && registrationLink && !tournament.rosterLocked;

        return (
            // Meta off: on the team panel the questions are seat, roster and invite. Team size
            // and format are answered — the kid is in.
            <RegisterShell tournament={tournament} showMeta={false}>
                <Card className="space-y-6">
                    {/* One row, not three. "Du er påmeldt" over "Du er påmeldt med Team Fjord."
                        is word-for-word containment, and it pushed PLASSEN DIN — the only thing
                        on this screen a kid needs at the door — to about 40% down the page. */}
                    <div className="flex items-center gap-3">
                        <CheckCircle2 className="shrink-0 text-success" size={22} />
                        <h1 className="mds-name-lg text-xl">{userTeam?.name || teamData.name}</h1>
                    </div>

                    {/* What became of the Discord name they typed. Silence here is the one
                        outcome that is not allowed: a kid who mistyped would walk away believing
                        their phone will buzz. Every branch says what to do next. */}
                    {discordResult && <DiscordOutcome result={discordResult} />}

                    {tournament.rosterLocked && (
                        <p className="mds-inline-notice flex items-center gap-2 border-l-warning text-sm text-fg-muted">
                            <Lock size={14} className="shrink-0 text-warning" />
                            {t('rosterLocked')}
                        </p>
                    )}

                    {/* The seat is the one field a player owns, and the floor runs on it. */}
                    {myPlayer && (
                        <div className="rounded border border-line bg-field/40 px-4 py-3">
                            <p className="mds-uppercase-label text-fg-subtle">{tPlayer('seat.label')}</p>
                            <SeatEditor
                                className="mt-1.5"
                                size="lg"
                                tournamentId={params.id}
                                seating={myPlayer.seating}
                                onSaved={handleSeatSaved}
                            />
                        </div>
                    )}

                    {/* Roster + seats, so the whole team can see who is sitting where. */}
                    {players.length > 0 && (
                        <div className="space-y-2">
                            <p className="mds-uppercase-label text-fg-subtle">
                                {t('roster', { count: players.length, size: teamSize })}
                            </p>
                            <ul className="space-y-1.5">
                                {players.map((player) => (
                                    <li
                                        key={player.id}
                                        className="flex items-center justify-between gap-3 rounded border border-line bg-page px-4 py-2.5"
                                    >
                                        <span className="flex min-w-0 items-center gap-2">
                                            <span className="mds-name text-sm">{player.nickname || player.name}</span>
                                            {player.isLeader && (
                                                <span title={t('teamLeader')}>
                                                    <Crown size={13} className="shrink-0 text-brand" />
                                                </span>
                                            )}
                                            {player.isMe && <Badge tone="info">{t('you')}</Badge>}
                                        </span>
                                        <span
                                            className={`mds-numeric shrink-0 text-sm ${player.seating ? 'font-bold' : 'text-fg-subtle'}`}
                                        >
                                            {player.seating || t('noSeat')}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {canInvite && (
                        <div className="space-y-3 rounded border border-brand bg-brand-soft p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="mds-uppercase-label text-brand">{t('inviteTitle')}</p>
                                <p className="text-xs text-fg-muted">
                                    {t.rich('slotsLeft', {
                                        count: slotsLeft,
                                        n: (chunks) => <span className="mds-numeric">{chunks}</span>,
                                    })}
                                </p>
                            </div>

                            {/* The code is what gets read out across a table; the link is what gets
                                pasted into Discord. Both are one tap from here. */}
                            <div className="flex flex-wrap items-center gap-3">
                                <div>
                                    <p className="mds-uppercase-label text-fg-subtle">{t('inviteCode')}</p>
                                    <p className="mds-numeric mt-0.5 text-2xl font-bold tracking-[0.12em]">
                                        {userTeam.inviteCode}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        copyText(userTeam.inviteCode, 'code');
                                        toast.success(t('inviteCodeCopied'));
                                    }}
                                >
                                    {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
                                    {t('copyCode')}
                                </Button>
                            </div>

                            <p className="break-all rounded border border-line bg-page px-3 py-2 text-xs text-fg-muted">
                                {registrationLink}
                            </p>
                            <Button
                                type="button"
                                className="w-full"
                                onClick={() => {
                                    copyText(registrationLink, 'link');
                                    toast.success(t('inviteLinkCopied'), t('inviteLinkCopiedHint'));
                                }}
                            >
                                {copied === 'link' ? <Check size={15} /> : <Copy size={15} />}
                                {t('copyInviteLink')}
                            </Button>
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                        <Link href={`/tournaments/${params.id}`}>
                            <Button variant="secondary">
                                {t('openOverview')}
                                <ArrowRight size={15} />
                            </Button>
                        </Link>
                        <Link href="/dashboard">
                            <Button variant="ghost">{t('goToDesk')}</Button>
                        </Link>
                        {/* Leaving is self-service only until the bracket exists; after that the
                            API answers 423 and an organizer has to move the player. */}
                        {!tournament.rosterLocked && myPlayer && (
                            <button
                                type="button"
                                onClick={handleLeaveTeam}
                                disabled={leaving}
                                className="ml-auto inline-flex h-8 items-center gap-2 px-2 text-xs font-semibold text-fg-subtle transition-colors hover:text-danger disabled:opacity-50"
                            >
                                {leaving ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
                                {t('leaveTeam')}
                            </button>
                        )}
                    </div>
                </Card>
            </RegisterShell>
        );
    }

    // Only visitors who are NOT on a team hit the closed notice.
    if (tournament.rosterLocked) {
        return (
            <RegisterShell tournament={tournament}>
                <Card className="space-y-3">
                    <div className="flex items-start gap-3 text-warning">
                        <Lock size={18} className="mt-1 shrink-0" />
                        <h1 className="font-brand text-xl font-bold text-fg">{t('closedTitle')}</h1>
                    </div>
                    {/* No name interpolation: it is the h1 two rows up, and in `mds-name
                        text-fg` the repeat was the loudest thing in the paragraph. */}
                    <p className="text-sm text-fg-muted">{t('closedBody')}</p>
                    <div>
                        <Link href={`/tournaments/${params.id}`}>
                            <Button variant="secondary">
                                {t('returnToTournament')}
                                <ArrowRight size={15} />
                            </Button>
                        </Link>
                    </div>
                </Card>
            </RegisterShell>
        );
    }

    if (requiresSignIn) {
        return (
            <RegisterShell tournament={tournament}>
                <Card className="space-y-5">
                    <div className="flex items-start gap-3">
                        <Gamepad2 className="mt-0.5 shrink-0 text-brand" size={22} />
                        <div className="space-y-1">
                            <h1 className="font-brand text-xl font-bold">
                                {tournament?.steamSignupEnabled
                                    ? t('steamRequiredTitle')
                                    : t('signInRequiredTitle')}
                            </h1>
                            <p className="text-sm text-fg-muted">
                                {tournament?.steamSignupEnabled
                                    ? t('steamRequiredBody')
                                    : t('signInRequiredBody')}
                            </p>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => signIn('steam', { callbackUrl })}>
                            <Gamepad2 size={16} />
                            {t('continueWithSteam')}
                        </Button>
                        {session && !sessionSteamId && (
                            <Button variant="secondary" type="button" onClick={() => signOut({ callbackUrl })}>
                                {t('switchAccount')}
                            </Button>
                        )}
                    </div>
                    <MockPersonaButtons callbackUrl={callbackUrl} />
                </Card>
            </RegisterShell>
        );
    }

    if (inviteCode && tournament?.steamSignupEnabled) {
        return (
            <RegisterShell tournament={tournament}>
                <Card className="space-y-5">
                    <div className="flex items-start gap-3">
                        <Users className="mt-0.5 shrink-0 text-brand" size={22} />
                        <div className="space-y-1">
                            <h1 className="font-brand text-xl font-bold">{t('joinTitle')}</h1>
                            <p className="text-sm text-fg-muted">
                                {t.rich('joinBody', {
                                    tournament: tournament.name,
                                    name: (chunks) => <span className="mds-name text-fg">{chunks}</span>,
                                })}
                            </p>
                        </div>
                    </div>

                    <div className="rounded border border-line bg-field/40 px-4 py-3">
                        <p className="mds-uppercase-label text-fg-subtle">{t('inviteCode')}</p>
                        <p className="mds-numeric mt-0.5 text-xl font-bold tracking-[0.12em] text-brand">
                            {inviteCode}
                        </p>
                    </div>

                    {/* Optional, but strongly prompted: the seat is how marshals find you. */}
                    <div className="max-w-[14rem]">
                        <Input
                            id="join-seating"
                            label={t('seatOptional')}
                            hint={tPlayer('seat.helper')}
                            type="text"
                            value={seating}
                            maxLength={SEAT_MAX_LENGTH}
                            onChange={(e) => setSeating(e.target.value)}
                            className="mds-numeric h-11 px-4 text-sm font-bold"
                            placeholder={tPlayer('seat.placeholder')}
                        />
                    </div>

                    {/* The Discord name, typed here rather than in a four-step dance across two
                        applications. Summit resolves it against the club's own server and keeps
                        the account, not the string, so a kid who renames themselves next week
                        still gets called. Optional: the crew still fetches everyone. */}
                    {props.discordConfigured && (
                        <div className="max-w-[18rem]">
                            <Input
                                id="join-discord"
                                label={t('discordOptional')}
                                hint={t('discordHint')}
                                type="text"
                                value={discordName}
                                maxLength={64}
                                onChange={(e) => setDiscordName(e.target.value)}
                                className="h-11 px-4 text-sm"
                                placeholder={t('discordPlaceholder')}
                            />
                        </div>
                    )}

                    {error && <ErrorNotice message={error} />}

                    <Button onClick={handleJoinTeam} disabled={submitting}>
                        {submitting ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                        {t('joinRoster')}
                    </Button>
                </Card>
            </RegisterShell>
        );
    }

    return (
        <RegisterShell tournament={tournament}>
            <form onSubmit={handleSubmit} className="space-y-5">
                <Card className="space-y-5">
                    <div className="space-y-1">
                        <h1 className="font-brand text-xl font-bold">{t('createTitle')}</h1>
                        <p className="text-sm text-fg-muted">
                            {/* Nothing for a 1v1: there is no "rest of the team" to invite, and
                                `canInvite` never renders the panel this sentence promised. */}
                            {tournament?.steamSignupEnabled
                                ? (tournament?.teamSize || 1) > 1
                                    ? t('createBodySteam')
                                    : null
                                : t('createBodyManual')}
                        </p>
                    </div>

                    <Input
                        id="team-name"
                        label={t('teamName')}
                        type="text"
                        required
                        value={teamData.name}
                        onChange={(e) => setTeamData({ ...teamData, name: e.target.value })}
                        className="h-11 px-4 text-sm"
                        placeholder={t('teamNamePlaceholder')}
                    />

                    {/* Seat for the registering player. Optional, but the LAN runs on it:
                        the signup route stores it on this player's own row. */}
                    {tournament?.steamSignupEnabled && (
                        <div className="max-w-[14rem]">
                            <Input
                                id="create-seating"
                                label={t('seatOptional')}
                                hint={tPlayer('seat.helper')}
                                type="text"
                                value={seating}
                                maxLength={SEAT_MAX_LENGTH}
                                onChange={(e) => setSeating(e.target.value)}
                                className="mds-numeric h-11 px-4 text-sm font-bold"
                                placeholder={tPlayer('seat.placeholder')}
                            />
                        </div>
                    )}

                    {/* The Discord name, typed here rather than in a four-step dance across two
                        applications. Summit resolves it against the club's own server and keeps
                        the account, not the string, so a kid who renames themselves next week
                        still gets called. Optional: the crew still fetches everyone. */}
                    {props.discordConfigured && (
                        <div className="max-w-[18rem]">
                            <Input
                                id="create-discord"
                                label={t('discordOptional')}
                                hint={t('discordHint')}
                                type="text"
                                value={discordName}
                                maxLength={64}
                                onChange={(e) => setDiscordName(e.target.value)}
                                className="h-11 px-4 text-sm"
                                placeholder={t('discordPlaceholder')}
                            />
                        </div>
                    )}

                    {/* Behind a link, after the seat. A file picker labelled "LAGLOGO
                        (VALGFRITT)" sat between the team name and the seat — the one field on
                        this form the LAN actually runs on — and most kids do not have a logo to
                        pick. A team that skips it gets a generated initials mark server-side, so
                        the bracket and the overlay never show a hole. */}
                    {!showLogoField ? (
                        <button
                            type="button"
                            onClick={() => setShowLogoField(true)}
                            className="self-start rounded-sm text-meta font-semibold text-brand hover:underline"
                        >
                            {t('addTeamLogo')}
                        </button>
                    ) : (
                    <div className="space-y-1.5">
                        <label className="mds-uppercase-label" htmlFor="team-logo">
                            {t('teamLogo')}
                        </label>
                        <div className="relative h-11">
                            <input
                                id="team-logo"
                                type="file"
                                accept="image/*"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        setLogoFile(file);
                                        setLogoPreview(URL.createObjectURL(file));
                                    }
                                }}
                                className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                            />
                            <div className="mds-input flex h-full items-center gap-3 px-4">
                                {/* The preview belongs here, at thumbnail size, not in a bordered
                                    panel of its own below the form echoing a team name the kid
                                    can see in the field they just typed it into. */}
                                {logoPreview && (
                                    <span className="relative h-7 w-7 shrink-0 overflow-hidden rounded-sm border border-line bg-page">
                                        <Image src={logoPreview} alt="" fill className="object-contain p-0.5" />
                                    </span>
                                )}
                                <span className="min-w-0 flex-1 truncate text-sm text-fg-subtle">
                                    {logoFile ? logoFile.name : t('uploadHint')}
                                </span>
                                <Upload size={15} className="shrink-0 text-fg-subtle" />
                            </div>
                        </div>
                    </div>
                    )}

                </Card>

                {!tournament?.steamSignupEnabled && (
                    <Card className="space-y-4">
                        <p className="mds-uppercase-label text-fg-subtle">
                            {t('rosterCount', { count: tournament?.teamSize ?? 0 })}
                        </p>
                        <div className="space-y-3">
                            {teamData.players.map((player, i) => (
                                <div
                                    key={i}
                                    className="grid grid-cols-1 gap-3 rounded border border-line bg-field/30 p-3 sm:grid-cols-2"
                                >
                                    <Input
                                        label={t('playerLabel', { index: i + 1 })}
                                        type="text"
                                        required
                                        value={player.name}
                                        onChange={(e) => updatePlayer(i, 'name', e.target.value)}
                                        className="h-10 px-3 text-sm"
                                        placeholder={t('playerPlaceholder')}
                                    />
                                    <Input
                                        label={t('steamProfile')}
                                        type="text"
                                        required
                                        value={player.steamId}
                                        onChange={(e) => updatePlayer(i, 'steamId', e.target.value)}
                                        className="mds-numeric h-10 px-3 text-sm"
                                        placeholder={t('steamProfilePlaceholder')}
                                    />
                                </div>
                            ))}
                        </div>
                    </Card>
                )}

                {error && <ErrorNotice message={error} />}

                <Button type="submit" className="w-full" disabled={submitting}>
                    {submitting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                    {submitting ? t('submitting') : t('submit')}
                </Button>
            </form>
        </RegisterShell>
    );
}
