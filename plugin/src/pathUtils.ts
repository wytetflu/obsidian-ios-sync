export function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesIgnore(p: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern) return false;
    const re = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
    return re.test(p);
  });
}

// Inserts a "(sync-conflict TIMESTAMP)" marker before the file extension.
export function conflictCopyPath(p: string, when: Date): string {
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  const slash = p.lastIndexOf("/");
  const dir = slash === -1 ? "" : p.slice(0, slash + 1);
  const name = slash === -1 ? p : p.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${dir}${name} (sync-conflict ${stamp})`;
  return `${dir}${name.slice(0, dot)} (sync-conflict ${stamp})${name.slice(dot)}`;
}
