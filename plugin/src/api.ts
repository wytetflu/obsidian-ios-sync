import type { VaultSyncSettings } from "./settings";

export interface RemoteEntry {
  hash: string;
  mtime: number;
  size: number;
  deleted?: boolean;
  deletedAt?: number;
}

function base(settings: VaultSyncSettings): string {
  return settings.serverUrl.replace(/\/$/, "");
}

function authHeaders(settings: VaultSyncSettings): HeadersInit {
  return { Authorization: `Bearer ${settings.token}` };
}

export async function fetchManifest(settings: VaultSyncSettings): Promise<Record<string, RemoteEntry>> {
  const res = await fetch(`${base(settings)}/api/manifest`, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { files: Record<string, RemoteEntry> };
  return body.files;
}

export async function uploadFile(settings: VaultSyncSettings, path: string, data: ArrayBuffer): Promise<RemoteEntry> {
  const url = `${base(settings)}/api/file?path=${encodeURIComponent(path)}&mtime=${Date.now()}`;
  const res = await fetch(url, { method: "PUT", headers: authHeaders(settings), body: data });
  if (!res.ok) throw new Error(`upload failed for ${path}: HTTP ${res.status}`);
  return (await res.json()) as RemoteEntry;
}

export async function downloadFile(settings: VaultSyncSettings, path: string): Promise<ArrayBuffer> {
  const url = `${base(settings)}/api/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`download failed for ${path}: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

export async function deleteRemoteFile(settings: VaultSyncSettings, path: string): Promise<void> {
  const url = `${base(settings)}/api/file?path=${encodeURIComponent(path)}&mtime=${Date.now()}`;
  const res = await fetch(url, { method: "DELETE", headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`delete failed for ${path}: HTTP ${res.status}`);
}

export async function checkHealth(settings: VaultSyncSettings): Promise<boolean> {
  try {
    const res = await fetch(`${base(settings)}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
