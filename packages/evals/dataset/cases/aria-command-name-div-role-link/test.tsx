import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import GuideLink from './input/GuideLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// axe only sees the missing name. This is the keyboard half of the bug: a native
// control activates on its own, and a custom one must take Enter itself.
it('opens from the keyboard', () => {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => createRoot(container).render(<GuideLink />));
  const control = container.querySelector<HTMLElement>(
    'a[href], button, [role="link"], [role="button"]',
  );
  if (!control) throw new Error('no control found');
  act(() => {
    if (control instanceof HTMLAnchorElement || control instanceof HTMLButtonElement) {
      control.click();
    } else {
      expect(control.tabIndex).toBe(0);
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      control.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }
  });
  expect(container.textContent).toContain('Water weekly');
});
