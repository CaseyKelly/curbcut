import { useState } from 'react';

export default function BasketRow() {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  if (removed) return <p>Removed from basket.</p>;
  return (
    <div className="basket-row">
      <button type="button" onClick={() => setOpen(!open)}>
        Fiddle-leaf fig
      </button>
      <button type="button" onClick={() => setRemoved(true)}>
        Remove
      </button>
      {open && <p>Ships in a 20 cm pot.</p>}
    </div>
  );
}
