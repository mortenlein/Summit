'use client';

import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';

const PERSONAS = [
  { id: 'marcus', label: 'Marcus' },
  { id: 'leo', label: 'Leo' },
  { id: 'sam', label: 'Sam' },
  { id: 'chloe', label: 'Chloe' },
  { id: 'toby', label: 'Toby' },
];

export function MockPersonaButtons({ callbackUrl }: { callbackUrl: string }) {
  // Before the env guard: hooks must not sit behind a conditional return.
  const t = useTranslations('landing');

  if (process.env.NEXT_PUBLIC_MOCK_AUTH !== 'true') {
    return null;
  }

  return (
    // The card lives here, not on the login page: in production this component renders null, so
    // a card around it there was a border drawn around one button.
    <div className="mds-card w-full space-y-3 p-5">
      {/* A persona is a *name*, so the buttons carry it as content: no uppercase, no tracking. */}
      <p className="mds-uppercase-label text-center text-fg-subtle">{t('login.mockPersonas')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PERSONAS.map((persona) => (
          <button
            key={persona.id}
            onClick={() => signIn('mock-user', { persona: persona.id, callbackUrl })}
            className="mds-btn-secondary mds-tap mds-name h-10 px-3 text-body"
            type="button"
            data-testid={`mock-persona-${persona.id}`}
          >
            {persona.label}
          </button>
        ))}
      </div>
    </div>
  );
}
