// Self-hosted sync server for the obsidian-ios-sync plugin.
// Serves any number of vaults from one process: each vault gets its own
// namespace under DATA_DIR, keyed by a vaultId taken from the URL
// (/api/<vaultId>/...). All vaults share one SYNC_TOKEN.
// Run with: bun run src/index.ts  (configure via env vars below)

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.SYNC_TOKEN;
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "./data");
// Tombstones older than this are pruned so metadata.json doesn't grow forever.
const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const VAULT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

if (!TOKEN) {
  console.error("SYNC_TOKEN env var is required (shared secret the plugin must send).");
  process.exit(1);
}

interface Entry {
  hash: string;
  mtime: number;
  size: number;
  deleted?: boolean;
  deletedAt?: number;
}

type Metadata = Record<string, Entry>;

interface VaultState {
  filesDir: string;
  metaPath: string;
  metadata: Metadata;
  saveQueue: Promise<unknown>;
}

const vaults = new Map<string, VaultState>();

async function getVault(vaultId: string): Promise<VaultState> {
  const cached = vaults.get(vaultId);
  if (cached) return cached;

  const vaultDir = path.join(DATA_DIR, vaultId);
  const filesDir = path.join(vaultDir, "files");
  const metaPath = path.join(vaultDir, "metadata.json");
  await mkdir(filesDir, { recursive: true });

  let metadata: Metadata = {};
  if (existsSync(metaPath)) {
    try {
      metadata = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      console.error(`metadata.json for vault "${vaultId}" is corrupt, starting from an empty index`);
    }
  }

  const state: VaultState = { filesDir, metaPath, metadata, saveQueue: Promise.resolve() };
  vaults.set(vaultId, state);
  return state;
}

function persist(state: VaultState) {
  // Serialize writes so concurrent requests can't interleave partial JSON writes.
  state.saveQueue = state.saveQueue.then(() =>
    writeFile(state.metaPath, JSON.stringify(state.metadata, null, 2))
  );
  return state.saveQueue;
}

function pruneTombstones(state: VaultState) {
  const now = Date.now();
  for (const [p, entry] of Object.entries(state.metadata)) {
    if (entry.deleted && entry.deletedAt && now - entry.deletedAt > TOMBSTONE_TTL_MS) {
      delete state.metadata[p];
    }
  }
}

// Resolves a vault-relative path safely, rejecting any traversal outside the vault's files dir.
function resolveSafePath(filesDir: string, relPath: string): string | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return null;
  const resolved = path.resolve(filesDir, relPath);
  const withSep = filesDir.endsWith(path.sep) ? filesDir : filesDir + path.sep;
  if (resolved !== filesDir && !resolved.startsWith(withSep)) return null;
  return resolved;
}

function unauthorized() {
  return new Response("unauthorized", { status: 401 });
}

function checkAuth(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${TOKEN}`;
  if (header.length !== expected.length) return false;
  // Constant-time-ish comparison to avoid trivial timing leaks on the token.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return new Response("ok");
    }

    // /api/<vaultId>/manifest  or  /api/<vaultId>/file
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts.length < 3) return new Response("not found", { status: 404 });
    const [, vaultId, resource] = parts;
    if (!VAULT_ID_RE.test(vaultId)) return new Response("invalid vault id", { status: 400 });

    if (!checkAuth(req)) return unauthorized();

    const vault = await getVault(vaultId);

    if (resource === "manifest" && req.method === "GET") {
      return Response.json({ files: vault.metadata });
    }

    if (resource === "file" && (req.method === "GET" || req.method === "PUT" || req.method === "DELETE")) {
      const relPath = url.searchParams.get("path") ?? "";
      const abs = resolveSafePath(vault.filesDir, relPath);
      if (!abs) return new Response("invalid path", { status: 400 });

      if (req.method === "GET") {
        const entry = vault.metadata[relPath];
        if (!entry || entry.deleted || !existsSync(abs)) return new Response("not found", { status: 404 });
        const buf = await readFile(abs);
        return new Response(buf, {
          headers: {
            "X-Mtime": String(entry.mtime),
            "X-Hash": entry.hash,
            "Content-Type": "application/octet-stream",
          },
        });
      }

      if (req.method === "PUT") {
        const mtimeParam = url.searchParams.get("mtime");
        const mtime = mtimeParam ? Number(mtimeParam) : Date.now();
        const body = new Uint8Array(await req.arrayBuffer());
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, body);
        const hashBuf = await crypto.subtle.digest("SHA-256", body);
        const hash = Buffer.from(hashBuf).toString("hex");
        vault.metadata[relPath] = { hash, mtime, size: body.byteLength };
        await persist(vault);
        return Response.json(vault.metadata[relPath]);
      }

      if (req.method === "DELETE") {
        const mtimeParam = url.searchParams.get("mtime");
        const deletedAt = mtimeParam ? Number(mtimeParam) : Date.now();
        if (existsSync(abs)) await rm(abs);
        vault.metadata[relPath] = { hash: "", mtime: deletedAt, size: 0, deleted: true, deletedAt };
        pruneTombstones(vault);
        await persist(vault);
        return Response.json({ ok: true });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`obsidian-sync-server listening on 0.0.0.0:${PORT}, data dir: ${DATA_DIR}`);
