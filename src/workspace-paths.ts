export function matchesWorkspace(
  sessionPaths: readonly string[],
  currentPaths: readonly string[]
): boolean {
  const current = new Set(
    currentPaths.map(normalizeWorkspacePath).filter(Boolean)
  );
  if (current.size === 0) {
    return true;
  }
  return sessionPaths
    .map(normalizeWorkspacePath)
    .some((workspacePath) => current.has(workspacePath));
}

export function normalizeWorkspacePath(workspacePath: string): string {
  const normalized = workspacePath.replaceAll("\\", "/");
  if (normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}
