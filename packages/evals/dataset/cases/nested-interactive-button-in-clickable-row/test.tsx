import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import BasketRow from './input/BasketRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => createRoot(container).render(<BasketRow />));
  return container;
}

/**
 * Activates the innermost control whose text includes `text`: the last match,
 * as a nested control follows its parent. Native ones click; custom ones take Enter.
 */
function activate(container: HTMLElement, text: string) {
  const controls = container.querySelectorAll<HTMLElement>(
    'button, summary, a[href], [role="button"]',
  );
  const control = [...controls].findLast((c) => c.textContent?.includes(text));
  if (!control) throw new Error(`no control for "${text}"`);
  act(() => {
    if (control.getAttribute('role') === null) {
      control.click();
    } else {
      expect(control.tabIndex).toBe(0);
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      control.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }
  });
}

// axe only checks that the controls stop nesting, which deleting one of them
// or its handler also does. A fix has to keep both working.
it('still expands the row', () => {
  const container = render();
  activate(container, 'Fiddle-leaf fig');
  expect(container.textContent).toContain('Ships in a 20 cm pot.');
});

it('still removes the item', () => {
  const container = render();
  activate(container, 'Remove');
  expect(container.textContent).toContain('Removed from basket.');
});
