import { App, TFile } from "obsidian";
import type { VaultSyncSettings, SyncStateEntry } from "./settings";
import { fetchManifest, uploadFile, downloadFile, deleteRemoteFile, RemoteEntry } from "./api";
import { sha256Hex } from "./hash";
import { dirname, matchesIgnore, conflictCopyPath } from "./pathUtils";

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: string[];
}

type LocalManifest = Record<string, { hash: string; size: number }>;

// Three-way merge: syncState is the common ancestor both sides agreed on at the last
// successful sync, localFiles/remoteFiles are the two candidate tips. This lets us tell
// "changed since we last agreed" apart from "differs because the other side moved on",
// without depending on wall-clock timestamps being consistent across devices.
export class SyncEngine {
  constructor(
    private app: App,
    private getSettings: () => VaultSyncSettings,
    private syncState: Record<string, SyncStateEntry>,
    private persist: () => Promise<void>
  ) {}

  private getFile(p: string): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(p);
    return af instanceof TFile ? af : null;
  }

  async run(): Promise<SyncResult> {
    const settings = this.getSettings();
    if (!settings.serverUrl || !settings.token) {
      throw new Error("Server URL and token must be configured first");
    }

    const result: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, errors: [] };

    const remoteFiles = await fetchManifest(settings);
    const localFiles = await this.buildLocalManifest(settings);

    const allPaths = new Set<string>([
      ...Object.keys(localFiles),
      ...Object.keys(remoteFiles),
      ...Object.keys(this.syncState),
    ]);

    for (const p of allPaths) {
      if (matchesIgnore(p, settings.ignorePatterns)) continue;
      try {
        await this.syncPath(p, localFiles, remoteFiles, settings, result);
      } catch (err) {
        result.errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.persist();
    return result;
  }

  private async buildLocalManifest(settings: VaultSyncSettings): Promise<LocalManifest> {
    const out: LocalManifest = {};
    for (const file of this.app.vault.getFiles()) {
      if (matchesIgnore(file.path, settings.ignorePatterns)) continue;
      const prev = this.syncState[file.path];
      if (prev && prev.size === file.stat.size && prev.mtimeAtHash === file.stat.mtime) {
        out[file.path] = { hash: prev.hash, size: prev.size };
        continue;
      }
      const data = await this.app.vault.readBinary(file);
      const hash = await sha256Hex(data);
      out[file.path] = { hash, size: file.stat.size };
      // Refresh the cache eagerly so a second sync in the same run (or a crash before
      // persist()) doesn't force a re-hash of a file we just read.
      this.syncState[file.path] = { hash, size: file.stat.size, mtimeAtHash: file.stat.mtime };
    }
    return out;
  }

  private async syncPath(
    p: string,
    localFiles: LocalManifest,
    remoteFiles: Record<string, RemoteEntry>,
    settings: VaultSyncSettings,
    result: SyncResult
  ): Promise<void> {
    const local = localFiles[p];
    const remoteRaw = remoteFiles[p];
    const remote = remoteRaw && !remoteRaw.deleted ? remoteRaw : undefined;
    const base = this.syncState[p];

    if (!local && !remote) {
      delete this.syncState[p];
      return;
    }

    if (local && !remote) {
      if (base && base.hash === local.hash) {
        await this.deleteLocal(p);
        result.deletedLocal++;
      } else {
        await this.upload(p, settings, result);
      }
      return;
    }

    if (!local && remote) {
      if (base && base.hash === remote.hash) {
        await deleteRemoteFile(settings, p);
        delete this.syncState[p];
        result.deletedRemote++;
      } else {
        await this.download(p, remote, result);
      }
      return;
    }

    if (local && remote) {
      if (local.hash === remote.hash) {
        this.syncState[p] = { hash: local.hash, size: local.size, mtimeAtHash: this.syncState[p]?.mtimeAtHash ?? 0 };
        return;
      }

      const localChanged = !base || base.hash !== local.hash;
      const remoteChanged = !base || base.hash !== remote.hash;

      if (localChanged && !remoteChanged) {
        await this.upload(p, settings, result);
      } else if (!localChanged && remoteChanged) {
        await this.download(p, remote, result);
      } else {
        // Both sides moved since the last common state (or there never was one): keep the
        // local copy as the file at `p`, and save the remote copy alongside so nothing is
        // silently lost. The conflict copy is picked up as a new local file next run.
        const remoteData = await downloadFile(settings, p);
        const copyPath = conflictCopyPath(p, new Date());
        await this.app.vault.createBinary(copyPath, remoteData);
        await this.upload(p, settings, result);
        result.conflicts++;
      }
    }
  }

  private async upload(p: string, settings: VaultSyncSettings, result: SyncResult): Promise<void> {
    const file = this.getFile(p);
    if (!file) return;
    const data = await this.app.vault.readBinary(file);
    const hash = await sha256Hex(data);
    await uploadFile(settings, p, data);
    this.syncState[p] = { hash, size: data.byteLength, mtimeAtHash: file.stat.mtime };
    result.uploaded++;
  }

  private async download(p: string, remote: RemoteEntry, result: SyncResult): Promise<void> {
    const settings = this.getSettings();
    const data = await downloadFile(settings, p);
    const dir = dirname(p);
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => undefined);
    }
    const existing = this.getFile(p);
    if (existing) {
      await this.app.vault.modifyBinary(existing, data);
    } else {
      await this.app.vault.createBinary(p, data);
    }
    const updated = this.getFile(p);
    this.syncState[p] = { hash: remote.hash, size: remote.size, mtimeAtHash: updated?.stat.mtime ?? Date.now() };
    result.downloaded++;
  }

  private async deleteLocal(p: string): Promise<void> {
    const file = this.getFile(p);
    if (file) await this.app.vault.delete(file);
    delete this.syncState[p];
  }
}
