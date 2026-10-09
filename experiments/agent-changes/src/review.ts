/** Overlapping paths warrant review; overlapping paths are not necessarily Git conflicts. */
export function overlappingFiles(changes: readonly (readonly string[])[]): string[] {
  const counts = new Map<string, number>();
  for (const paths of changes) {
    for (const path of new Set(paths)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([path]) => path).sort();
}
