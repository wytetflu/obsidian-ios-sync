export interface VaultSyncSettings {
  serverUrl: string;
  token: string;
  // Namespaces this vault on a server shared by several vaults. Defaults to the
  // vault's own name (sanitized) the first time the plugin loads; editable in
  // case two vaults share a name or a custom id is preferred.
  vaultId: string;
  intervalSec: number;
  autoSync: boolean;
  ignorePatterns: string[];
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: "http://localhost:8787",
  token: "",
  vaultId: "",
  intervalSec: 60,
  autoSync: true,
  ignorePatterns: [".obsidian/*", ".trash/*", ".git/*"],
};

export function sanitizeVaultId(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "vault";
}

export interface SyncStateEntry {
  hash: string;
  size: number;
  // The vault file's own stat.mtime at the moment we last hashed it, used to skip
  // re-hashing unchanged files on the next run instead of re-reading every file's bytes.
  mtimeAtHash: number;
}

export interface PluginData {
  settings: VaultSyncSettings;
  syncState: Record<string, SyncStateEntry>;
}

export function defaultData(): PluginData {
  return { settings: { ...DEFAULT_SETTINGS, ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns] }, syncState: {} };
}
