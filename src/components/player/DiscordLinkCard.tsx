'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Loader2, MessageSquare } from 'lucide-react';
import { Badge, Button, Card, CardTitle } from '@/components/ui';

/** What GET /api/me/discord hands back. `discordId` is never part of it, for anybody. */
interface DiscordLinkState {
  configured: boolean;
  inviteUrl: string;
  linked: boolean;
  username?: string | null;
  dmState?: string | null;
  optOut?: boolean;
  code?: string | null;
  codeExpiresAt?: string | null;
}

/**
 * The `/koble` card.
 *
 * Three steps, in the order a kid actually has to do them: join the server, type the command,
 * paste the code. Step one exists because a player who has Discord but was never added to the
 * club's server has no path at all otherwise — `/koble` does not exist for a non-member and
 * does not autocomplete.
 *
 * The copy button copies the **bare code, never the slash**: pasting `/koble H7K2QP` sends a
 * plain text message, because Discord's autocomplete only fires on a typed `/`.
 *
 * While a code is live the card polls, because the redemption happens in another application
 * entirely — without that the kid runs the command, tabs back to a page still showing the same
 * code, and concludes it failed.
 *
 * `variant="desk"` renders nothing once linked: the player desk is a one-question surface and
 * a permanently-parked "you're all set" row is exactly the clutter being stripped off it.
 */
export function DiscordLinkCard({ variant = 'profile' }: { variant?: 'profile' | 'desk' }) {
  const t = useTranslations('discord');
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const { data, isLoading } = useQuery<DiscordLinkState>({
    queryKey: ['discord-link'],
    queryFn: async () => {
      const res = await fetch('/api/me/discord');
      if (!res.ok) throw new Error('discord link state');
      return res.json();
    },
    // Poll only while there is something to wait for: a live code, and a link that is either
    // missing or known-undeliverable (the "run /koble again" recovery).
    refetchInterval: (query) => {
      const state = query.state.data as DiscordLinkState | undefined;
      if (!state?.code) return false;
      return !state.linked || state.dmState === 'BLOCKED' ? 3000 : false;
    },
  });

  const expiresAt = data?.codeExpiresAt ? new Date(data.codeExpiresAt).getTime() : null;
  const msLeft = expiresAt ? expiresAt - now : 0;
  const expired = Boolean(data?.code && expiresAt && msLeft <= 0);

  // A one-second tick only while a code is on screen — the card is otherwise inert.
  useEffect(() => {
    if (!data?.code || expired) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data?.code, expired]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['discord-link'] });

  const requestCode = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/me/discord/code', { method: 'POST' });
      if (!res.ok) throw new Error('code');
      return res.json();
    },
    onSuccess: () => {
      setFailed(false);
      setNow(Date.now());
      refresh();
    },
    onError: () => setFailed(true),
  });

  const unlink = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/me/discord', { method: 'DELETE' });
      if (!res.ok) throw new Error('unlink');
      return res.json();
    },
    onSuccess: () => {
      setFailed(false);
      refresh();
    },
    onError: () => setFailed(true),
  });

  const resumeDms = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/me/discord', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optOut: false }),
      });
      if (!res.ok) throw new Error('optOut');
      return res.json();
    },
    onSuccess: refresh,
    onError: () => setFailed(true),
  });

  // Nothing to offer: no bot key, no guild, no invite — the same self-hiding posture the
  // alerts button has with no VAPID keys. Never a dead end, never a nag.
  if (isLoading || !data?.configured) return null;
  if (variant === 'desk' && data.linked) return null;

  const copyCode = async () => {
    if (!data.code) return;
    try {
      await navigator.clipboard?.writeText(data.code);
    } catch {
      // A blocked clipboard is survivable: the code is on screen in a face built for retyping.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /**
   * The code, or the button that mints one. Shared by the unlinked state and by the blocked
   * state, because "kjør /koble på nytt" is the recovery path for closed DMs and it needs a
   * code like any other run.
   */
  const codePanel =
    data.code && !expired ? (
      <div className="space-y-2">
        <p className="mds-uppercase-label text-fg-subtle">{t('card.codeLabel')}</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* .mds-numeric: this is read off a screen and retyped on a keyboard, so it gets the
              mono face where 0/O and 1/l cannot be confused. */}
          <span
            className="mds-numeric select-all text-3xl font-bold tracking-[0.3em] text-fg"
            data-testid="discord-link-code"
          >
            {data.code}
          </span>
          <Button variant="secondary" size="sm" onClick={copyCode} data-testid="discord-copy">
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? t('card.copied') : t('card.copy')}
          </Button>
        </div>
        <p className="text-xs text-fg-subtle">
          {t('card.expires', { minutes: Math.max(1, Math.ceil(msLeft / 60000)) })}
        </p>
        <p className="flex items-center gap-2 text-xs text-fg-muted" data-testid="discord-waiting">
          <Loader2 size={12} className="animate-spin" />
          {t('card.waiting')}
        </p>
      </div>
    ) : (
      <div className="space-y-2">
        {expired && (
          <p className="text-xs text-warning" data-testid="discord-code-expired">
            {t('card.expired')}
          </p>
        )}
        <Button
          onClick={() => requestCode.mutate()}
          disabled={requestCode.isPending}
          data-testid="discord-get-code"
        >
          {expired ? t('card.newCode') : t('card.getCode')}
        </Button>
      </div>
    );

  return (
    <Card className="space-y-3" data-testid="discord-link-card">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquare size={16} className="text-fg-subtle" />
        <CardTitle className="text-base">{t('card.title')}</CardTitle>
        {/* Never tone="ready": that green means "din tur" everywhere else in the product. */}
        <Badge tone="neutral">{t('card.optional')}</Badge>
      </div>

      {data.linked ? (
        <div className="space-y-2">
          <p className="text-sm text-fg" data-testid="discord-linked">
            {t('card.linked', { username: data.username || '' })}
          </p>
          {/* "sendt", never "levert": a 204 proves Discord accepted a message, not that a kid
              read one. The wording here is load-bearing. */}
          {data.dmState === 'SENT' && <p className="text-xs text-fg-muted">{t('card.dmSent')}</p>}
          {data.dmState === 'UNKNOWN' && (
            <p className="text-xs text-fg-muted">{t('card.dmUnconfirmed')}</p>
          )}
          {data.dmState === 'BLOCKED' && (
            <div className="space-y-2 rounded-sm border border-warning/40 bg-warning/10 p-2">
              <p className="text-xs font-semibold text-warning">{t('card.dmBlockedTitle')}</p>
              <p className="text-xs text-fg-muted">{t('card.dmBlockedBody')}</p>
              {codePanel}
            </div>
          )}
          {data.optOut && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-fg-muted">{t('card.optedOutNotice')}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => resumeDms.mutate()}
                data-testid="discord-resume"
              >
                {t('card.resume')}
              </Button>
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => unlink.mutate()}
            disabled={unlink.isPending}
            data-testid="discord-unlink"
          >
            {t('card.unlink')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">{t('card.body')}</p>

          <ol className="space-y-2 text-sm">
            <li className="flex flex-wrap items-center gap-2">
              <Step n={1} />
              <span>{t('card.stepJoin')}</span>
              {data.inviteUrl && (
                <a
                  href={data.inviteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
                  data-testid="discord-invite"
                >
                  <Link2 size={13} />
                  {t('card.stepJoinAction')}
                </a>
              )}
            </li>
            <li className="flex items-center gap-2">
              <Step n={2} />
              {/* The command is a fixed ASCII string in both languages — Discord localises
                  command names by the *client's* language, so we never print a translated one. */}
              <span>{t('card.stepCommand')}</span>
            </li>
            <li className="flex items-center gap-2">
              <Step n={3} />
              <span>{t('card.stepCode')}</span>
            </li>
          </ol>

          {codePanel}

          {/* Permanent and non-dismissible. Nobody may read this card as a reason to stay put. */}
          <p className="text-xs text-fg-subtle">{t('card.caveat')}</p>
        </div>
      )}

      {failed && <p className="text-xs text-danger">{t('card.error')}</p>}
    </Card>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="mds-numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tint text-[11px] font-bold text-fg-muted">
      {n}
    </span>
  );
}
