import { useState } from 'react';

export default function BasketRow() {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  if (removed) return <p>Removed from basket.</p>;
  return (
    <div className="basket-row">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setOpen(!open);
        }}
      >
        Fiddle-leaf fig
        <button type="button" onClick={() => setRemoved(true)}>
          Remove
        </button>
      </div>
      {open && <p>Ships in a 20 cm pot.</p>}
    </div>
  );
}
