import { useState } from 'react';

export default function EmailAlerts() {
  const [on, setOn] = useState(false);
  return (
    <div className="setting">
      <div
        role="switch"
        aria-checked={on}
        className={on ? 'switch on' : 'switch'}
        onClick={() => setOn(!on)}
      >
        Email alerts
      </div>
    </div>
  );
}
