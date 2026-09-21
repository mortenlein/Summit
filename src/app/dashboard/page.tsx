import React, { Suspense } from "react";
import { useTranslations } from "next-intl";
import UserDashboardClient from "@/components/UserDashboardClient";

// Not async: `useTranslations` is the Server Component API too, but it cannot be called from an
// async component. There is nothing to await here, so the shell stays synchronous.
export default function DashboardPage() {
  const t = useTranslations("player");
  return (
    <Suspense
      fallback={
        // Desk-shaped, not a full-screen message: the shell that is about to appear.
        <div className="min-h-screen bg-page">
          <main
            className="mds-container space-y-6 py-6 sm:py-8"
            aria-busy="true"
            aria-label={t("desk.label")}
          >
            {/* A shimmer where the name goes, not the word "SPILLERDESK". The desk itself no
                longer prints that label, so printing it here made it flicker in and out on
                every load — the one animation on the page, in the wrong place. */}
            <div className="h-8 w-40 animate-pulse rounded-sm bg-white/5" />
            <div className="h-40 animate-pulse rounded-lg border border-line bg-card" />
          </main>
        </div>
      }
    >
      <UserDashboardClient />
    </Suspense>
  );
}
