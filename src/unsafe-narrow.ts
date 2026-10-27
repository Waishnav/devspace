/**
 * Reinterpret a value across a library or wire boundary TypeScript cannot prove.
 *
 * Prefer a parser or a named domain type. Use this only when the surrounding
 * code already established the contract (SDK handle, FFI, or decoded JSON).
 */
export function unsafeNarrow<T>(value: {} | null | undefined): T {
  // SAFETY: The caller checked or constructed a value that already matches T;
  // the generic parameter is the proof TypeScript cannot thread through the boundary.
  return value as T;
}
