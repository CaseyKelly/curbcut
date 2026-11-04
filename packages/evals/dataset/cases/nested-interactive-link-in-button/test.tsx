import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import AddToBasket from './input/AddToBasket';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// axe only checks that the controls stop nesting, which deleting one of them
// also does. A fix has to keep both.
it('keeps the button and the delivery link', () => {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => createRoot(container).render(<AddToBasket />));
  const controls = [...container.querySelectorAll('button, [role="button"]')];
  expect(controls.some((c) => c.textContent?.includes('Add to basket'))).toBe(true);
  const link = container.querySelector('a[href="/help/delivery"]');
  expect(link?.textContent).toContain('Delivery info');
});
