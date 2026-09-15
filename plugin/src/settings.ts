export interface VaultSyncSettings {
  serverUrl: string;
  token: string;
  intervalSec: number;
  autoSync: boolean;
  ignorePatterns: string[];
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: "http://localhost:8787",
  token: "",
  intervalSec: 60,
  autoSync: true,
  ignorePatterns: [".obsidian/*", ".trash/*", ".git/*"],
};

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
