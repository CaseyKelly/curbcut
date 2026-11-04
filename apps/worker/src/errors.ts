/** A failure that retrying won't fix, such as a bad payload or a blocked URL. The job fails at once. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

/** A scan target that isn't http/https or resolves to a private address (#5). */
export class UnsafeUrlError extends PermanentError {
  override name = 'UnsafeUrlError';
}
