"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Check, Globe } from "lucide-react";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";

/**
 * Norsk ↔ English.
 *
 * The choice is persisted server-side (cookie, plus the user row when signed in) and the page
 * is then refreshed, because the strings are rendered on the server. Two locales means a plain
 * toggle rather than a dropdown: one tap, no menu to open on a phone.
 */
export default function LocaleToggle() {
  const locale = useLocale() as Locale;
  const t = useTranslations("nav");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const next: Locale = locale === "nb" ? "en" : "nb";

  const switchTo = async (target: Locale) => {
    setBusy(true);
    try {
      await fetch("/api/me/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
      // Server components hold the translated strings, so a refresh is what actually swaps them.
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  };

  return (
    // Borderless, to match the weight of the glyphs beside it in the header bar.
    <button
      type="button"
      onClick={() => void switchTo(next)}
      disabled={busy || pending}
      data-testid="locale-toggle"
      aria-label={`${t("language")}: ${LOCALE_LABELS[locale]}`}
      title={`${t("language")} — ${LOCALE_LABELS[next]}`}
      className="mds-tap flex h-9 items-center gap-1.5 rounded-sm px-2 text-label font-semibold uppercase tracking-wide text-fg-muted transition-colors hover:bg-tint hover:text-fg disabled:opacity-60"
    >
      <Globe size={15} aria-hidden />
      {locale.toUpperCase()}
    </button>
  );
}

/** Explicit two-option list, for settings surfaces where a toggle is too terse. */
export function LocaleChoice() {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [busy, setBusy] = useState<Locale | null>(null);

  const choose = async (target: Locale) => {
    if (target === locale) return;
    setBusy(target);
    try {
      await fetch("/api/me/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex gap-2" data-testid="locale-choice">
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => void choose(code)}
          disabled={busy !== null}
          aria-pressed={code === locale}
          data-testid={`locale-choice-${code}`}
          className={`mds-tap flex items-center gap-2 rounded-sm border px-3 py-2 text-meta font-semibold transition-colors ${
            code === locale
              ? "border-brand bg-brand-soft text-brand"
              : "border-line bg-tint text-fg-muted hover:border-line-hover hover:text-fg"
          }`}
        >
          {code === locale && <Check size={14} aria-hidden />}
          {LOCALE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
