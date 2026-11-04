import { useState } from 'react';

export default function EmailAlerts() {
  const [on, setOn] = useState(false);
  return (
    <div className="setting">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={on ? 'switch on' : 'switch'}
        onClick={() => setOn(!on)}
      >
        Email alerts
      </button>
    </div>
  );
}
