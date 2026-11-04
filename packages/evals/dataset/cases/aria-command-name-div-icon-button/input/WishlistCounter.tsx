import { useState } from 'react';

export default function WishlistCounter() {
  const [saved, setSaved] = useState(0);
  return (
    <div className="wishlist">
      <div role="button" className="icon-button" onClick={() => setSaved(saved + 1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 14L2 8a3.5 3.5 0 0 1 6-3 3.5 3.5 0 0 1 6 3z" fill="currentColor" />
        </svg>
      </div>
      <p>Wishlist: {saved} saved</p>
    </div>
  );
}
