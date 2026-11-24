import type { Impact } from '@curbcut/core';

// The word is always shown, so colour is never the only signal. Every pair
// has at least 4.5:1 contrast.
const STYLES: Record<Impact, string> = {
  critical: 'border-red-900 bg-red-900 text-white',
  serious: 'border-orange-900 bg-orange-900 text-white',
  moderate: 'border-yellow-800 bg-yellow-100 text-yellow-950',
  minor: 'border-neutral-600 bg-neutral-100 text-neutral-900',
};

export function ImpactBadge({ impact }: { impact: Impact }) {
  return (
    <span
      className={`inline-block rounded-md border px-2 py-0.5 text-sm font-semibold capitalize ${STYLES[impact]}`}
    >
      {impact}
    </span>
  );
}
