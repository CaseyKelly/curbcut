import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import WishlistCounter from './input/WishlistCounter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// axe only sees the missing name. This is the keyboard half of the bug: a native
// button activates on its own, and a custom one must take Enter itself.
it('activates from the keyboard', () => {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => createRoot(container).render(<WishlistCounter />));
  const control = container.querySelector<HTMLElement>('button, [role="button"]');
  if (!control) throw new Error('no button found');
  act(() => {
    if (control instanceof HTMLButtonElement) {
      control.click();
    } else {
      expect(control.tabIndex).toBe(0);
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      control.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }
  });
  expect(container.textContent).toContain('1 saved');
});
