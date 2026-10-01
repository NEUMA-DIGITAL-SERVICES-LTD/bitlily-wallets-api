/**
 * Safely extract a message from a thrown value. `catch (e)` binds `unknown`
 * under strict mode — thrown values aren't guaranteed to be Errors (code can
 * throw strings, objects, null). Narrow instead of asserting `any`.
 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Extract an error code (e.g. Postgres '23505') if present. */
export function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null
    ? (e as { code?: string }).code
    : undefined;
}
