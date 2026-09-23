import { getTournament } from '@/lib/api';
import { isDiscordLinkConfigured } from '@/lib/discord-link';
import RegisterClient from './RegisterClient';

// The prefetched tournament is session-dependent (staff see the invite code and the bridge
// token; players do not), so this page is rendered per request and never cached or shared.
export const dynamic = 'force-dynamic';

/**
 * Server shell for the register page.
 *
 * It exists to put the tournament's name on the first frame. The page a kid reaches by tapping
 * "meld på" used to open as a spinner in a bordered box over an otherwise black screen, and the
 * name that confirms they are in the right place arrived a round-trip later. `getTournament`
 * mirrors GET /api/tournaments/[id] exactly, so the client's own fetch replaces this with the
 * same shape rather than a different one.
 *
 * A missing tournament is NOT notFound() here: the client renders its own not-found state with
 * a way back, and that state is what the e2e suite and a lost kid both expect to see.
 */
export default async function RegisterPage(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const tournament = await getTournament(params.id).catch(() => null);

    // Whether to offer the Discord field at all. Asking a kid for a name nothing will ever use
    // is worse than not asking: they type it, nothing happens, and they believe they are
    // reachable.
    return (
        <RegisterClient
            params={props.params}
            initialTournament={tournament}
            discordConfigured={isDiscordLinkConfigured()}
        />
    );
}
