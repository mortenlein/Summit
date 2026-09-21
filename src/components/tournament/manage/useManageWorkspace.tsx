'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMatchStream } from '@/hooks/useMatchStream';
import { ApiError, apiRequest, clientApi } from '@/lib/client-api';
import { useToast } from '@/components/ToastProvider';
import { useApiErrorMessage } from '@/i18n/error-message';

const EMPTY_MATCH_FORM = { homeScore: 0, awayScore: 0, bestOf: 1, status: 'READY', mapScores: [] as any[] };

/**
 * Form state for the match modal. `scoreLimit` is deliberately absent — the server derives it
 * from bestOf. Legacy WAITING_FOR_PLAYERS rows are shown as READY ("Called").
 */
export const buildMatchForm = (match: any) => ({
    homeScore: match.homeScore || 0,
    awayScore: match.awayScore || 0,
    bestOf: match.bestOf || 1,
    status: match.status === 'WAITING_FOR_PLAYERS' ? 'READY' : (match.status || 'READY'),
    mapScores: typeof match.mapScores === 'string' ? JSON.parse(match.mapScores) : (Array.isArray(match.mapScores) ? match.mapScores : []),
});

/**
 * Everything the organizer workspace does to the server: the five queries it reads, the live match
 * stream, every mutation with its optimistic update and its toast, and the editor state the tabs
 * and modals write through. `TournamentManageClient` is then only composition — which tab is on
 * screen and which modal is open.
 *
 * It stays one hook on purpose: the mutations share `invalidateWorkspace`, one error-to-toast
 * policy (409 means "someone else got there first — refetch and say so"), and the open match row
 * whose `updatedAt` is the concurrency token every save carries.
 */
export function useManageWorkspace(tournamentId: string) {
    // Every toast and every window.confirm in here is read by an organizer mid-LAN, so they go
    // through the catalogue like any other copy — `useTranslations` is a hook and works here.
    const t = useTranslations('organizer.toast');
    const tConfirm = useTranslations('organizer.confirm');
    const queryClient = useQueryClient();
    const router = useRouter();
    const toast = useToast();
    const apiErrorMessage = useApiErrorMessage();
    const [newTeam, setNewTeam] = useState({ name: '', logoUrl: '', seed: '', players: [] });
    const [generating, setGenerating] = useState(false);
    // Only the id is held: the modal reads the live row out of the teams query so a roster edit is
    // reflected the moment the query is invalidated.
    const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
    const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
    const [draftSeeds, setDraftSeeds] = useState<Record<string, number | string>>({});
    const [importCsv, setImportCsv] = useState('');
    const [editingMatch, setEditingMatch] = useState<any>(null);
    const [matchForm, setMatchForm] = useState(EMPTY_MATCH_FORM);

    /** Open the match editor on a row, with the form primed from it. */
    const openMatchModal = (match: any) => {
        setEditingMatch(match);
        setMatchForm(buildMatchForm(match));
    };

    // Queries
    const { data: tournament, isLoading: tournamentLoading } = useQuery({
        queryKey: ['tournament', tournamentId],
        queryFn: async () => clientApi.getTournament(tournamentId),
    });

    const { data: teams = [], isLoading: teamsLoading } = useQuery({
        queryKey: ['teams', tournamentId],
        queryFn: async () => clientApi.getTeams(tournamentId),
    });

    const { data: matches = [], isLoading: matchesLoading } = useQuery({
        queryKey: ['matches', tournamentId],
        queryFn: async () => clientApi.getMatches(tournamentId),
    });

    const { data: activityData } = useQuery({
        queryKey: ['activity', tournamentId],
        queryFn: async () => clientApi.getAuditLog(tournamentId),
    });

    const { data: notificationData } = useQuery({
        queryKey: ['notifications', tournamentId],
        queryFn: async () => clientApi.getNotifications(tournamentId),
    });

    const loading = tournamentLoading || teamsLoading || matchesLoading;
    // Live row for the open editor; the modal closes by itself if the team disappears.
    const editingTeam = editingTeamId ? teams.find((team: any) => team.id === editingTeamId) : null;
    const activity = activityData?.entries || [];
    const notifications = notificationData?.notifications || [];

    const invalidateWorkspace = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] }),
            queryClient.invalidateQueries({ queryKey: ['teams', tournamentId] }),
            queryClient.invalidateQueries({ queryKey: ['matches', tournamentId] }),
            queryClient.invalidateQueries({ queryKey: ['activity', tournamentId] }),
            queryClient.invalidateQueries({ queryKey: ['notifications', tournamentId] }),
            queryClient.invalidateQueries({ queryKey: ['tournaments'] }),
        ]);
    };

    // The server's `error` field stays English (it is what the log and the e2e suite read); the
    // sentence the organizer sees is resolved from the refusal's `code`. See src/lib/api-errors.ts.
    const showMutationError = (error: unknown, fallback: string) => {
        if (error instanceof ApiError) {
            if (error.status === 409) {
                toast.error(t('refreshNeeded'), apiErrorMessage(error, fallback));
                void invalidateWorkspace();
                return;
            }
            toast.error(fallback, apiErrorMessage(error, fallback));
            return;
        }

        toast.error(fallback, apiErrorMessage(error, fallback));
    };

    // Live SSE match updates
    useMatchStream(tournamentId, (data) => {
        queryClient.setQueryData(['matches', tournamentId], (prev: any[] | undefined) =>
            prev?.map((m) => (m.id === data.matchId ? { ...m, ...data.match } : m))
        );
    });

    // Mutations
    const addTeamMutation = useMutation({
        mutationFn: async (payload: any) =>
            apiRequest(`/api/tournaments/${tournamentId}/teams`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }),
        onMutate: async (payload) => {
            await queryClient.cancelQueries({ queryKey: ['teams', tournamentId] });
            const previousTeams = queryClient.getQueryData<any[]>(['teams', tournamentId]) || [];
            const optimisticTeam = {
                id: `optimistic-${Date.now()}`,
                name: payload.name,
                logoUrl: payload.logoUrl || '',
                seed: payload.seed || previousTeams.length + 1,
                players: payload.players || [],
            };
            queryClient.setQueryData(['teams', tournamentId], [...previousTeams, optimisticTeam]);
            return { previousTeams };
        },
        onSuccess: () => {
            setNewTeam({ name: '', logoUrl: '', seed: '', players: [] });
            toast.success(t('teamAdded'), t('teamAddedHint'));
            void invalidateWorkspace();
        },
        onError: (error, _variables, context) => {
            if (context?.previousTeams) {
                queryClient.setQueryData(['teams', tournamentId], context.previousTeams);
            }
            showMutationError(error, t('couldNotAddTeam'));
        },
    });

    const deleteTeamMutation = useMutation({
        mutationFn: async ({ teamId, force }: { teamId: string; teamSnapshot?: any; force?: boolean }) =>
            clientApi.deleteTeam(teamId, { force }),
        onSuccess: (result: any, variables) => {
            // A forced removal happens while the roster is locked, and re-registering is refused
            // by the same lock — so Undo is only offered on the unlocked path.
            const teamSnapshot = variables.force ? undefined : variables.teamSnapshot;
            const matchesAffected = Number(result?.matchesAffected) || 0;
            toast.success(
                t('teamRemoved'),
                matchesAffected > 0
                    ? t('teamRemovedMatchesHint', { count: matchesAffected })
                    : t('teamRemovedHint'),
                teamSnapshot
                    ? {
                        label: t('undo'),
                        onAction: () => {
                            void apiRequest(`/api/tournaments/${tournamentId}/teams`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    name: teamSnapshot.name,
                                    logoUrl: teamSnapshot.logoUrl || '',
                                    seed: teamSnapshot.seed || '',
                                    players: (teamSnapshot.players || []).map((player: any) => ({
                                        name: player.name,
                                        nickname: player.nickname || '',
                                        countryCode: player.countryCode || '',
                                        seating: player.seating || '',
                                        steamId: player.steamId || '',
                                        isLeader: Boolean(player.isLeader),
                                    })),
                                }),
                            })
                                .then(() => {
                                    toast.success(t('teamRestored'), t('teamRestoredHint', { name: teamSnapshot.name }));
                                    void invalidateWorkspace();
                                })
                                .catch((error) => showMutationError(error, t('couldNotRestoreTeam')));
                        },
                    }
                    : undefined
            );
            void invalidateWorkspace();
        },
        onError: (error) => showMutationError(error, t('couldNotRemoveTeam')),
    });

    const updateSeedsMutation = useMutation({
        mutationFn: async (newTeams: any[]) =>
            Promise.all(newTeams.map((team, index) =>
                apiRequest(`/api/teams/${team.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ seed: index + 1, expectedUpdatedAt: team.updatedAt }),
                })
            )),
        onSuccess: () => {
            toast.success(t('seedingUpdated'), t('seedingUpdatedHint'));
            void invalidateWorkspace();
        },
        onError: (error) => showMutationError(error, t('couldNotSaveSeeds')),
    });

    // Generating locks the roster, so every regeneration has to pass overrideLock or the second
    // call is refused by the lock guard (423).
    const generateMatchesMutation = useMutation({
        mutationFn: async ({ overrideLock }: { overrideLock: boolean }) => {
            setGenerating(true);
            try {
                return await apiRequest(`/api/tournaments/${tournamentId}/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(overrideLock ? { overrideLock: true } : {}),
                });
            } finally {
                setGenerating(false);
            }
        },
        onSuccess: (_data, variables) => {
            toast.success(t(variables.overrideLock ? 'bracketRegenerated' : 'bracketGenerated'), t('bracketReadyHint'));
            void invalidateWorkspace();
        },
        onError: (error) => showMutationError(error, t('couldNotGenerate')),
    });

    /**
     * `alreadyConfirmed` is for the call sites that put up their own (accurate) dialog first,
     * so staff are never asked twice.
     */
    const handleGenerateMatches = (alreadyConfirmed = false) => {
        const regenerating = matches.length > 0;
        if (!alreadyConfirmed) {
            const message = tConfirm(regenerating ? 'rebuildBracket' : 'generateBracket');
            if (!window.confirm(message)) return;
        }
        generateMatchesMutation.mutate({ overrideLock: regenerating });
    };

    const saveMatchMutation = useMutation({
        mutationFn: async ({ id, ...payload }: any) =>
            apiRequest(`/api/matches/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...payload,
                    expectedUpdatedAt: editingMatch?.updatedAt,
                }),
            }),
        onSuccess: () => {
            setEditingMatch(null);
            toast.success(t('matchSaved'), t('matchSavedHint'));
            void invalidateWorkspace();
        },
        onError: (error) => {
            // Both guards on this route answer 409 — the optimistic-concurrency check and the
            // "downstream match already started" refusal — so show the server's own wording.
            if (error instanceof ApiError && error.status === 409) {
                toast.error(t('matchNotSaved'), error.message);
                void invalidateWorkspace();
                return;
            }
            showMutationError(error, t('couldNotSaveMatch'));
        },
    });

    const loadMatchMutation = useMutation({
        mutationFn: async (matchId: string) =>
            apiRequest(`/api/matches/${matchId}/load`, {
                method: 'POST',
            }),
        onSuccess: () => {
            void invalidateWorkspace();
        },
        onError: (error) => showMutationError(error, t('couldNotStartMatch')),
    });

    const updateTournamentMutation = useMutation({
        mutationFn: async (payload: any) =>
            apiRequest(`/api/tournaments/${tournamentId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...payload,
                    expectedUpdatedAt: tournament?.updatedAt,
                }),
            }),
        onMutate: async (payload) => {
            await queryClient.cancelQueries({ queryKey: ['tournament', tournamentId] });
            const previousTournament = queryClient.getQueryData(['tournament', tournamentId]);
            queryClient.setQueryData(['tournament', tournamentId], (current: any) => ({ ...current, ...payload }));
            return { previousTournament };
        },
        onSuccess: () => {
            toast.success(t('settingsUpdated'), t('settingsUpdatedHint'));
            void invalidateWorkspace();
        },
        onError: (error, _variables, context) => {
            if (context?.previousTournament) {
                queryClient.setQueryData(['tournament', tournamentId], context.previousTournament);
            }
            showMutationError(error, t('couldNotUpdateTournament'));
        },
    });

    const importTeamsMutation = useMutation({
        mutationFn: async (csv: string) =>
            apiRequest(`/api/tournaments/${tournamentId}/teams`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'import',
                    csv,
                }),
            }),
        onSuccess: (result: any) => {
            setImportCsv('');
            toast.success(t('teamsImported'), t('teamsImportedHint', { count: result.count || 0 }));
            void invalidateWorkspace();
        },
        onError: (error) => showMutationError(error, t('couldNotImportTeams')),
    });

    const handleSaveSeeds = async () => {
        const payload = teams.map((team: any, index: number) => ({
            ...team,
            seed: draftSeeds[team.id] !== undefined ? draftSeeds[team.id] : (team.seed || index + 1),
        }));
        await updateSeedsMutation.mutateAsync(payload);
        setDraftSeeds({});
    };

    /**
     * Team/roster editor handlers. Each resolves `true` when the server accepted the write, so the
     * modal can drop its local draft; failures (423 locked / 409 stale) are surfaced as toasts here
     * and leave the draft in place for a retry.
     */
    const isRosterLocked = Boolean(tournament?.rosterLocked);

    const handleSaveTeamFields = async (teamId: string, payload: { name: string; logoUrl: string; seed: string }) => {
        const team = teams.find((entry: any) => entry.id === teamId);
        try {
            await clientApi.updateTeam(teamId, {
                name: payload.name,
                logoUrl: payload.logoUrl,
                // Seeding is refused while the roster is locked, so it is not even sent.
                ...(isRosterLocked ? {} : { seed: payload.seed }),
                expectedUpdatedAt: team?.updatedAt,
            });
            toast.success(t('teamSaved'), t('teamSavedHint'));
            await invalidateWorkspace();
            return true;
        } catch (error) {
            showMutationError(error, t('couldNotSaveTeam'));
            return false;
        }
    };

    /** `steamId`/`isLeader` are locked fields; omit them so a seat fix is not refused with them. */
    const buildPlayerPayload = (draft: any, includeIdentity: boolean) => ({
        name: draft.name,
        nickname: draft.nickname,
        countryCode: draft.countryCode,
        seating: draft.seating,
        ...(includeIdentity ? { steamId: draft.steamId, isLeader: Boolean(draft.isLeader) } : {}),
    });

    const handleSavePlayer = async (playerId: string, draft: any) => {
        try {
            await clientApi.updatePlayer(playerId, buildPlayerPayload(draft, !isRosterLocked));
            toast.success(t('playerSaved'), t('playerSavedHint', { name: draft.name }));
            await invalidateWorkspace();
            return true;
        } catch (error) {
            showMutationError(error, t('couldNotSavePlayer'));
            return false;
        }
    };

    const handleAddPlayer = async (teamId: string, draft: any) => {
        try {
            await clientApi.addTeamPlayer(teamId, buildPlayerPayload(draft, true));
            toast.success(t('playerAdded'), t('playerAddedHint', { name: draft.name }));
            await invalidateWorkspace();
            return true;
        } catch (error) {
            showMutationError(error, t('couldNotAddPlayer'));
            return false;
        }
    };

    const handleDeletePlayer = async (playerId: string) => {
        try {
            await clientApi.deletePlayer(playerId);
            toast.success(t('playerRemoved'), t('playerRemovedHint'));
            await invalidateWorkspace();
            return true;
        } catch (error) {
            showMutationError(error, t('couldNotRemovePlayer'));
            return false;
        }
    };

    const handleDeleteTeam = (teamId: string) => {
        const teamSnapshot = teams.find((team: any) => team.id === teamId);
        if (!teamSnapshot) return;

        // While the roster is locked the team is already placed in the bracket, so the removal has
        // to be forced and the dialog says exactly what that does to the matches.
        const message = tConfirm(isRosterLocked ? 'forceRemoveTeam' : 'removeTeam', { name: teamSnapshot.name });
        if (!window.confirm(message)) return;

        deleteTeamMutation.mutate({ teamId, teamSnapshot, force: isRosterLocked });
    };

    const handleAnnounceDiscord = async (match: any, type: 'START' | 'RESULT') => {
        try {
            await apiRequest(`/api/discord/announce`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    matchId: match.id,
                    tournamentId,
                    type,
                }),
            });
            toast.success(t('announcementSent'), t('announcementSentHint'));
            void invalidateWorkspace();
        } catch (error) {
            showMutationError(error, t('couldNotAnnounce'));
            throw error;
        }
    };

    const handleImportCsv = async () => {
        await importTeamsMutation.mutateAsync(importCsv);
    };

    const handleExportCsv = () => {
        window.open(`/api/tournaments/${tournamentId}/teams?format=csv`, '_blank', 'noopener,noreferrer');
        toast.info(t('exportStarted'), t('exportStartedHint'));
    };

    const handleCopyPublicLink = async () => {
        await navigator.clipboard.writeText(`${window.location.origin}/tournaments/${tournamentId}`);
        toast.success(t('linkCopied'), t('linkCopiedHint'));
    };

    const onDragStart = (e: React.DragEvent, index: number) => {
        setDraggedItemIndex(index);
        e.dataTransfer.effectAllowed = 'move';
    };

    const onDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        if (draggedItemIndex === null || draggedItemIndex === index) return;

        const items = [...teams];
        const draggedItem = items[draggedItemIndex];
        items.splice(draggedItemIndex, 1);
        items.splice(index, 0, draggedItem);
        
        setDraggedItemIndex(index);
        queryClient.setQueryData(['teams', tournamentId], items);
    };

    const onDragEnd = () => {
        if (draggedItemIndex !== null) {
            updateSeedsMutation.mutate(teams);
        }
        setDraggedItemIndex(null);
    };

    /**
     * Registering a team from the Teams tab. Blank roster rows are dropped before the POST: an
     * admin may register a partial team and fill the seats in later.
     */
    const onAddTeam = (event: React.FormEvent) => {
        event.preventDefault();
        const players = (newTeam.players || [])
            .map((player: any) => ({
                name: (player.name || '').trim() || (player.nickname || '').trim(),
                nickname: (player.nickname || '').trim(),
                countryCode: (player.countryCode || '').trim(),
                seating: (player.seating || '').trim(),
                steamId: (player.steamId || '').trim(),
            }))
            .filter((player: any) => player.name);
        addTeamMutation.mutate({ ...newTeam, players });
    };

    /**
     * Scores are left out on purpose: the server fills in the walkover scoreline (scoreLimit : 0)
     * in the winner's favour.
     */
    const forfeitMatch = (side: 'HOME' | 'AWAY') => {
        saveMatchMutation.mutate({
            id: editingMatch.id,
            bestOf: matchForm.bestOf,
            status: matchForm.status,
            forfeit: side,
        });
    };

    const loadMatch = async (matchId: string) => {
        try {
            const result: any = await loadMatchMutation.mutateAsync(matchId);
            // Never `result.message ||` — that preferred a server-rendered English sentence over
            // the crew's own language, and the sentence it carried claimed both teams had been
            // notified, which the route cannot know. The copy lives in `messages/` like
            // everything else, and it promises an attempt, not a delivery.
            toast.success(
                t('matchCalled'),
                result?.recall ? t('matchAlreadyCalledHint') : t('matchCalledHint')
            );
        } catch (error) {
            showMutationError(error, t('couldNotStartMatch'));
        }
    };

    /** The confirmation dialog for this lives in ManageSettings, not here. */
    const deleteTournament = async () => {
        try {
            await apiRequest(`/api/tournaments/${tournamentId}`, { method: 'DELETE' });
            toast.success(t('tournamentDeleted'), t('tournamentDeletedHint'), {
                label: t('openAdmin'),
                onAction: () => router.push('/admin'),
            });
            router.push('/admin');
            router.refresh();
        } catch (error) {
            showMutationError(error, t('couldNotDeleteTournament'));
        }
    };

    return {
        // data
        tournament,
        teams,
        matches,
        activity,
        notifications,
        loading,
        // team registration form
        newTeam,
        setNewTeam,
        onAddTeam,
        // team editor
        editingTeam,
        openTeamEditor: (team: any) => setEditingTeamId(team.id),
        closeTeamEditor: () => setEditingTeamId(null),
        handleSaveTeamFields,
        handleSavePlayer,
        handleAddPlayer,
        handleDeletePlayer,
        handleDeleteTeam,
        // seeding
        draftSeeds,
        setDraftSeeds,
        handleSaveSeeds,
        draggedItemIndex,
        onDragStart,
        onDragOver,
        onDragEnd,
        // bracket
        generating,
        handleGenerateMatches,
        // match editor
        editingMatch,
        openMatchModal,
        closeMatchModal: () => setEditingMatch(null),
        matchForm,
        setMatchForm,
        saveMatch: () => saveMatchMutation.mutate({ id: editingMatch.id, ...matchForm }),
        forfeitMatch,
        isSavingMatch: saveMatchMutation.isPending,
        isLoadingMatch: loadMatchMutation.isPending,
        loadMatch,
        handleAnnounceDiscord,
        // settings
        updateTournament: (payload: any) => updateTournamentMutation.mutate(payload),
        updating: updateTournamentMutation.isPending,
        deleteTournament,
        // import / export / share
        importCsv,
        setImportCsv,
        handleImportCsv,
        handleExportCsv,
        importing: importTeamsMutation.isPending,
        handleCopyPublicLink,
    };
}
