'use client';

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Loader2, ArrowLeft } from "lucide-react";
import Link from 'next/link';
import { MockPersonaButtons } from "@/components/MockPersonaButtons";

function LoginContent() {
  const t = useTranslations("landing");
  const searchParams = useSearchParams();
  // A bare /login is a player. It used to default to "/admin", which made `staff` true for
  // every visitor who followed the header link or the landing CTA — so a 12-year-old signing in
  // for the first time read three lines about crew allowlists, and was then dropped on /admin,
  // where middleware bounces them straight back to "/". Staff arrive here with their own
  // callbackUrl, from the route that turned them away.
  const rawCallbackUrl = searchParams.get("callbackUrl") || "/dashboard";
  const callbackUrl = rawCallbackUrl.startsWith("/") ? rawCallbackUrl : "/dashboard";

  const staff = callbackUrl.startsWith("/marshal") || callbackUrl.startsWith("/admin");
  const heading = callbackUrl.startsWith("/marshal") ? t("login.titleStaff") : t("login.title");

  return (
    // No local orbs and no `bg-page`: globals.css already paints a radial atmosphere behind
    // every screen, and two blurred brand circles made this the one page that did not match it.
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center p-6">
      <div className="w-full max-w-[420px] space-y-8">
        <div className="space-y-4 text-center">
          {/* No shield tile. A 56px brand square with a security glyph is the visual language of
              a bank login, on the page where a kid signs in to find out where they sit. */}
          <div className="space-y-2">
            <h1 className="font-brand text-head font-bold tracking-tight text-fg">{heading}</h1>
            <p className="mx-auto max-w-sm text-body text-fg-muted">
              {staff ? t("login.blurbStaff") : t("login.blurb")}
            </p>
          </div>
        </div>

        {/* Not a card. In production MockPersonaButtons renders null, so the card wrapped one
            button and lit its own border on hover as though the panel were the target. The dev
            harness keeps a surface of its own. */}
        <div className="flex flex-col items-center gap-5">
          <button
            type="button"
            onClick={() => signIn("steam", { callbackUrl })}
            data-testid="steam-login"
            className="mds-btn-primary mds-tap h-12 w-full text-label font-bold uppercase tracking-[0.16em]"
          >
            {t("login.steamButton")}
          </button>

          <MockPersonaButtons callbackUrl={callbackUrl} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Link
            href="/"
            className="group mds-tap inline-flex items-center gap-2 rounded-sm text-meta font-semibold text-fg-muted transition-colors hover:text-fg"
          >
            <ArrowLeft size={15} aria-hidden className="transition-transform group-hover:-translate-x-0.5" />
            {t("login.backHome")}
          </Link>
          <p className="mds-uppercase-label text-fg-subtle">Steam OpenID</p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[70vh] items-center justify-center bg-page">
          <Loader2 className="animate-spin text-brand" size={32} aria-hidden />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
