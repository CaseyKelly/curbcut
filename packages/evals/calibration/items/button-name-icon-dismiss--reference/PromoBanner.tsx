import { useState } from 'react';

export default function PromoBanner() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="promo-banner">
      <p>Free delivery on orders over £40 this week.</p>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setOpen(false)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
    </div>
  );
}
