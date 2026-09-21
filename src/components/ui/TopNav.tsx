'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { Command, LogOut, Menu, X } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import LocaleToggle from '@/components/LocaleToggle';
import { useTranslations } from 'next-intl';
import { openCommandPalette } from '@/components/CommandPalette';

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The single, persistent top chrome for the whole app. Rendered once by NavigationWrapper
 * (never per-page) so it doesn't remount/restyle on navigation. Its nav is derived from the
 * signed-in user's role, so it's identical on every surface — only the active item changes.
 */
export function TopNav() {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const signedIn = status === 'authenticated';
  const user = session?.user as { name?: string; image?: string; role?: string } | undefined;
  const role = user?.role;
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the drawer on navigation.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const links: NavLink[] = [{ href: '/tournaments', label: t('tournaments') }];
  if (signedIn) links.push({ href: '/dashboard', label: t('myDesk') });
  if (role === 'admin') links.push({ href: '/admin', label: t('admin') });
  if (role === 'admin' || role === 'marshal') links.push({ href: '/marshal/dashboard', label: t('marshal') });
  if (signedIn) links.push({ href: '/profile', label: t('profile') });

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // best-effort; continue to NextAuth sign-out
    }
    await signOut({ callbackUrl: '/' });
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/80 backdrop-blur">
      <a
        href="#main"
        className="sr-only rounded-sm bg-brand px-3 py-2 text-meta font-bold text-white focus:not-sr-only focus:absolute focus:left-3 focus:top-2 focus:z-50"
      >
        {tc('skipToContent')}
      </a>
      <div className="mds-container flex h-14 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-6">
          <Link href="/" className="shrink-0 rounded-sm font-brand text-title font-bold tracking-tight">
            Summit
          </Link>
          <nav aria-label={t('primary')} className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={isActive(l.href) ? 'page' : undefined}
                className={`rounded-sm px-3 py-1.5 text-body font-semibold transition-colors ${
                  isActive(l.href) ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg'
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {signedIn ? (
            <>
              <div className="hidden items-center gap-2 sm:flex">
                {user?.image ? (
                  <Image
                    src={user.image}
                    alt=""
                    width={26}
                    height={26}
                    className="h-6 w-6 rounded-full border border-line"
                  />
                ) : null}
                <span className="mds-name hidden text-meta text-fg-muted lg:block">{user?.name}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="hidden items-center gap-1.5 rounded-sm px-1 text-meta font-semibold text-fg-muted transition-colors hover:text-fg lg:flex"
              >
                <LogOut size={14} aria-hidden />
                {tc('signOut')}
              </button>
            </>
          ) : (
            <Link
              href="/login"
              className="hidden rounded-sm px-1 text-meta font-semibold text-fg-muted transition-colors hover:text-fg sm:block"
            >
              {tc('signIn')}
            </Link>
          )}
          {/* The palette is the fast path (⌘K / "/") for the organizer and the crew on a laptop,
              and it keeps its visible door there. It is hidden on phones on purpose: a
              12-year-old has no keyboard shortcut to discover, every command behind it is a link
              already in the hamburger drawer, and it was the fourth glyph in a row of four on a
              390px header. Tournament pages keep a labelled phone door of their own
              (`tournament-open-command-palette`), which is where a kid would look for one. */}
          <button
            type="button"
            aria-label={t('palette.open')}
            title={t('palette.openTitle')}
            data-testid="open-command-palette"
            onClick={openCommandPalette}
            className="mds-tap hidden items-center justify-center rounded-sm p-2 text-fg-muted transition-colors hover:bg-tint hover:text-fg md:flex"
          >
            <Command size={17} aria-hidden />
          </button>
          <LocaleToggle />
          <ThemeToggle />
          <button
            type="button"
            aria-label={t('toggleMenu')}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-panel"
            data-testid="mobile-nav-toggle"
            onClick={() => setMenuOpen((v) => !v)}
            className="mds-tap flex items-center justify-center rounded-sm p-2 text-fg-muted transition-colors hover:bg-tint hover:text-fg md:hidden"
          >
            {menuOpen ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          id="mobile-nav-panel"
          aria-label={t('primary')}
          data-testid="mobile-nav-panel"
          className="border-t border-line bg-page md:hidden"
        >
          <div className="mds-container flex flex-col gap-1 py-3">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setMenuOpen(false)}
                aria-current={isActive(l.href) ? 'page' : undefined}
                className={`mds-tap flex items-center rounded-sm px-3 py-3 text-body font-semibold transition-colors ${
                  isActive(l.href)
                    ? 'bg-brand-soft text-brand'
                    : 'text-fg-muted hover:bg-tint hover:text-fg'
                }`}
              >
                {l.label}
              </Link>
            ))}
            {signedIn ? (
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="mds-tap mt-1 flex items-center gap-2 rounded-sm px-3 py-3 text-left text-body font-semibold text-fg-muted transition-colors hover:bg-tint hover:text-fg"
              >
                <LogOut size={15} aria-hidden />
                {tc('signOut')}
              </button>
            ) : (
              <Link
                href="/login"
                onClick={() => setMenuOpen(false)}
                className="mds-tap flex items-center rounded-sm px-3 py-3 text-body font-semibold text-fg-muted transition-colors hover:bg-tint hover:text-fg"
              >
                {tc('signIn')}
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
