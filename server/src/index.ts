// Minimal self-hosted sync server for the obsidian-ios-sync plugin.
// Stores one vault's files on disk plus a JSON metadata index (hash/mtime/tombstones).
// Run with: bun run src/index.ts  (configure via env vars below)

import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.SYNC_TOKEN;
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "./data");
const FILES_DIR = path.join(DATA_DIR, "files");
const META_PATH = path.join(DATA_DIR, "metadata.json");
// Tombstones older than this are pruned so metadata.json doesn't grow forever.
const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 90;

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

await mkdir(FILES_DIR, { recursive: true });

async function loadMetadata(): Promise<Metadata> {
  if (!existsSync(META_PATH)) return {};
  try {
    return JSON.parse(await readFile(META_PATH, "utf8"));
  } catch {
    console.error("metadata.json is corrupt, starting from an empty index");
    return {};
  }
}

let metadata = await loadMetadata();
let saveQueue: Promise<unknown> = Promise.resolve();

function persist() {
  // Serialize writes so concurrent requests can't interleave partial JSON writes.
  saveQueue = saveQueue.then(() =>
    writeFile(META_PATH, JSON.stringify(metadata, null, 2))
  );
  return saveQueue;
}

function pruneTombstones() {
  const now = Date.now();
  for (const [p, entry] of Object.entries(metadata)) {
    if (entry.deleted && entry.deletedAt && now - entry.deletedAt > TOMBSTONE_TTL_MS) {
      delete metadata[p];
    }
  }
}

// Resolves a vault-relative path safely, rejecting any traversal outside FILES_DIR.
function resolveSafePath(relPath: string): string | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return null;
  const resolved = path.resolve(FILES_DIR, relPath);
  const withSep = FILES_DIR.endsWith(path.sep) ? FILES_DIR : FILES_DIR + path.sep;
  if (resolved !== FILES_DIR && !resolved.startsWith(withSep)) return null;
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

    if (!checkAuth(req)) return unauthorized();

    if (url.pathname === "/api/manifest" && req.method === "GET") {
      return Response.json({ files: metadata });
    }

    if (url.pathname === "/api/file" && (req.method === "GET" || req.method === "PUT" || req.method === "DELETE")) {
      const relPath = url.searchParams.get("path") ?? "";
      const abs = resolveSafePath(relPath);
      if (!abs) return new Response("invalid path", { status: 400 });

      if (req.method === "GET") {
        const entry = metadata[relPath];
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
        metadata[relPath] = { hash, mtime, size: body.byteLength };
        await persist();
        return Response.json(metadata[relPath]);
      }

      if (req.method === "DELETE") {
        const mtimeParam = url.searchParams.get("mtime");
        const deletedAt = mtimeParam ? Number(mtimeParam) : Date.now();
        if (existsSync(abs)) await rm(abs);
        metadata[relPath] = { hash: "", mtime: deletedAt, size: 0, deleted: true, deletedAt };
        pruneTombstones();
        await persist();
        return Response.json({ ok: true });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`obsidian-sync-server listening on 0.0.0.0:${PORT}, data dir: ${DATA_DIR}`);
