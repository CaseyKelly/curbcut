'use client';

import { useActionState, useEffect, useRef } from 'react';
import { startScan, type ScanFormState } from '@/app/actions';

const initial: ScanFormState = { url: '', error: null };

/**
 * The URL form (#8). The browser's own validation is off (`noValidate`) so
 * every mistake gets one of our messages in the same place: tied to the field
 * with `aria-describedby`, announced as an alert, and with focus back in the
 * field.
 */
export function ScanForm() {
  const [state, formAction, pending] = useActionState(startScan, initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.error) input.current?.focus();
  }, [state]);

  return (
    <form
      action={formAction}
      noValidate
      // A disabled button would drop keyboard focus, so a second submit is ignored instead.
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <label htmlFor="scan-url" className="block font-medium">
        Page address
      </label>
      <p id="scan-url-hint" className="mt-1 text-neutral-700">
        The full address of a public page, such as https://example.com/.
      </p>
      <input
        ref={input}
        id="scan-url"
        name="url"
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        required
        defaultValue={state.url}
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? 'scan-url-hint scan-url-error' : 'scan-url-hint'}
        className="mt-2 block w-full rounded-md border border-neutral-700 px-3 py-2"
      />
      {state.error ? (
        <p id="scan-url-error" role="alert" className="mt-2 font-medium text-red-800">
          Error: {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        aria-disabled={pending}
        className="mt-4 rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700"
      >
        {pending ? 'Starting scan…' : 'Scan page'}
      </button>
    </form>
  );
}
