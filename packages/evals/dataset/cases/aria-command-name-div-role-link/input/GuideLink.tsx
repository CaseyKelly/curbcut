import { useState } from 'react';

export default function GuideLink() {
  const [open, setOpen] = useState(false);
  return (
    <div className="guide">
      <h2>Care guide</h2>
      <div role="link" className="chevron" onClick={() => setOpen(true)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 2l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      {open && <p>Water weekly and keep out of direct sun.</p>}
    </div>
  );
}
