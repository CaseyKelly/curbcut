import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import EmailAlerts from './input/EmailAlerts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const isOn = (el: HTMLElement) =>
  el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';

// axe only sees the missing aria-checked. This is the keyboard half of the bug:
// a native control toggles on its own, and a custom one must take Space itself.
it('toggles from the keyboard', () => {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => createRoot(container).render(<EmailAlerts />));
  const control = container.querySelector<HTMLElement>(
    'input[type="checkbox"], button, [role="switch"], [role="checkbox"]',
  );
  if (!control) throw new Error('no switch found');
  const before = isOn(control);
  act(() => {
    if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) {
      control.click();
    } else {
      expect(control.tabIndex).toBe(0);
      control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      control.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    }
  });
  expect(isOn(control)).toBe(!before);
});
