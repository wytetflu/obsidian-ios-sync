import { requestUrl } from "obsidian";
import type { VaultSyncSettings } from "./settings";

// All network calls go through Obsidian's requestUrl() rather than fetch(): on mobile
// the plugin runs inside a WebView, where a plain fetch() to a self-hosted HTTP server
// is blocked twice over — as mixed content, and by CORS preflight on the Authorization
// header. requestUrl() performs the request natively, outside the WebView sandbox.

export interface RemoteEntry {
  hash: string;
  mtime: number;
  size: number;
  deleted?: boolean;
  deletedAt?: number;
}

function base(settings: VaultSyncSettings): string {
  const root = settings.serverUrl.replace(/\/$/, "");
  return `${root}/api/${encodeURIComponent(settings.vaultId)}`;
}

function authHeaders(settings: VaultSyncSettings): Record<string, string> {
  return { Authorization: `Bearer ${settings.token}` };
}

export async function fetchManifest(settings: VaultSyncSettings): Promise<Record<string, RemoteEntry>> {
  const res = await requestUrl({
    url: `${base(settings)}/manifest`,
    method: "GET",
    headers: authHeaders(settings),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const body = res.json as { files: Record<string, RemoteEntry> };
  return body.files;
}

export async function uploadFile(settings: VaultSyncSettings, path: string, data: ArrayBuffer): Promise<RemoteEntry> {
  const res = await requestUrl({
    url: `${base(settings)}/file?path=${encodeURIComponent(path)}&mtime=${Date.now()}`,
    method: "PUT",
    headers: { ...authHeaders(settings), "Content-Type": "application/octet-stream" },
    body: data,
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`upload failed for ${path}: HTTP ${res.status}`);
  return res.json as RemoteEntry;
}

export async function downloadFile(settings: VaultSyncSettings, path: string): Promise<ArrayBuffer> {
  const res = await requestUrl({
    url: `${base(settings)}/file?path=${encodeURIComponent(path)}`,
    method: "GET",
    headers: authHeaders(settings),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`download failed for ${path}: HTTP ${res.status}`);
  return res.arrayBuffer;
}

export async function deleteRemoteFile(settings: VaultSyncSettings, path: string): Promise<void> {
  const res = await requestUrl({
    url: `${base(settings)}/file?path=${encodeURIComponent(path)}&mtime=${Date.now()}`,
    method: "DELETE",
    headers: authHeaders(settings),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`delete failed for ${path}: HTTP ${res.status}`);
}

export async function checkHealth(settings: VaultSyncSettings): Promise<boolean> {
  try {
    const root = settings.serverUrl.replace(/\/$/, "");
    const res = await requestUrl({ url: `${root}/api/health`, method: "GET", throw: false });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
