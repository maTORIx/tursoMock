// Embedded libSQL (native) instead of bun:sqlite so the mock exposes libSQL's
// native vector search (F32_BLOB / vector32 / vector_distance_cos /
// libsql_vector_idx / vector_top_k), matching production Turso semantics.
// better-sqlite3-compatible synchronous API.
import Database from "libsql";
import { existsSync, mkdirSync, rmSync, unlinkSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

let DB_DIR = "./db";
let IN_MEMORY = false;

// Database connection cache
const dbCache: Map<string, Database> = new Map();
// read-only トークン用の接続 (SQLITE_OPEN_READONLY)。SQL の中身にかかわらず SQLite が書き込みを拒む
const readOnlyCache: Map<string, Database> = new Map();

// SQL storage for sql_id references
export const sqlStorage: Map<string, Map<number, string>> = new Map();

/**
 * Keep every database in process memory instead of on disk. Data is gone when
 * the server stops; intended for test suites, where it removes the fsync cost
 * of each autocommit write.
 *
 * In-memory databases support neither read-only tokens nor /v1/upload: a
 * second, read-only connection to a memory database cannot be opened (the
 * readonly flag has no effect on a shared-cache memory database), and an
 * uploaded file cannot be loaded into one. The server rejects both.
 */
export function setInMemory(enabled: boolean): void {
	IN_MEMORY = enabled;
}

export function isInMemory(): boolean {
	return IN_MEMORY;
}

export function setDbDir(dir: string): void {
	DB_DIR = dir;
}

export function getDbDir(): string {
	return DB_DIR;
}

export function ensureDbDir(): void {
	if (!existsSync(DB_DIR)) {
		mkdirSync(DB_DIR, { recursive: true });
	}
}

function dbPathOf(dbName: string): string {
	return join(DB_DIR, `${dbName}.db`);
}

function prepareDbPath(dbName: string): string {
	const dbPath = dbPathOf(dbName);
	// Namespaced databases ("<ns>/<db>") live in a subdirectory.
	mkdirSync(dirname(dbPath), { recursive: true });
	return dbPath;
}

export function getDb(dbName: string): Database {
	if (dbCache.has(dbName)) {
		return dbCache.get(dbName)!;
	}
	const db = new Database(IN_MEMORY ? ":memory:" : prepareDbPath(dbName));
	dbCache.set(dbName, db);
	return db;
}

/**
 * read-only トークンの接続。`mode=ro` で開くので、CTE や複文に紛れた書き込みも
 * `PRAGMA query_only = 0` も SQLite が SQLITE_READONLY で拒む (文の先頭の語では判定しない)。
 * ファイルは書ける接続 (getDb) が先に作る。インメモリでは開けない (呼ぶ側が先に断る)。
 */
export function getReadOnlyDb(dbName: string): Database {
	if (IN_MEMORY) throw new Error("read-only connections are not supported with --memory");
	const cached = readOnlyCache.get(dbName);
	if (cached) return cached;
	getDb(dbName);
	const path = resolve(dbPathOf(dbName)).replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
	const db = new Database(`file:${path}?mode=ro`);
	readOnlyCache.set(dbName, db);
	return db;
}

export function closeDb(dbName: string): void {
	for (const cache of [dbCache, readOnlyCache]) {
		const db = cache.get(dbName);
		if (db) {
			db.close();
			cache.delete(dbName);
		}
	}
}

export function closeAllDbs(): void {
	for (const cache of [readOnlyCache, dbCache]) {
		for (const [, db] of cache) db.close();
		cache.clear();
	}
	sqlStorage.clear();
}

export function deleteDbFiles(dbName: string): void {
	const dbPath = dbPathOf(dbName);
	if (existsSync(dbPath)) {
		unlinkSync(dbPath);
		// Also remove WAL and SHM files if they exist
		const walPath = `${dbPath}-wal`;
		const shmPath = `${dbPath}-shm`;
		if (existsSync(walPath)) unlinkSync(walPath);
		if (existsSync(shmPath)) unlinkSync(shmPath);
	}
	const marker = uploadMarker(dbName);
	if (existsSync(marker)) unlinkSync(marker);
}

/** 印は DB ファイルの隣 (名前空間の DB なら名前空間のディレクトリの中) に置く */
function uploadMarker(dbName: string): string {
	return join(DB_DIR, `${dbName}.awaiting-upload`);
}

/** A database created with `seed: database_upload` accepts one /v1/upload. File mode only. */
export function markAwaitingUpload(dbName: string): void {
	if (IN_MEMORY) throw new Error("database upload is not supported with --memory");
	writeFileSync(prepareDbPath(dbName).replace(/\.db$/, ".awaiting-upload"), "");
}

export function isAwaitingUpload(dbName: string): boolean {
	return !IN_MEMORY && existsSync(uploadMarker(dbName));
}

/** Swap the database file for an uploaded one (closes the cached handles first). */
export function replaceDbFile(dbName: string, bytes: Uint8Array): void {
	if (IN_MEMORY) throw new Error("database upload is not supported with --memory");
	closeDb(dbName);
	const dbPath = dbPathOf(dbName);
	for (const p of [`${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(p)) unlinkSync(p);
	writeFileSync(dbPath, bytes);
	unlinkSync(uploadMarker(dbName));
}

/** List the databases directly under `namespace`, or the un-namespaced ones when omitted. */
export function listDatabases(namespace?: string): string[] {
	if (IN_MEMORY) {
		const prefix = namespace ? `${namespace}/` : "";
		return [...dbCache.keys()]
			.filter((key) => key.startsWith(prefix))
			.map((key) => key.slice(prefix.length))
			.filter((name) => !name.includes("/"));
	}
	const dir = namespace ? join(DB_DIR, namespace) : DB_DIR;
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".db"))
		.map((f) => f.replace(".db", ""));
}

export function resetAllDbs(): void {
	closeAllDbs();
	ensureDbDir();
	for (const entry of readdirSync(DB_DIR, { withFileTypes: true })) {
		const entryPath = join(DB_DIR, entry.name);
		if (entry.isDirectory()) {
			// Namespace directory (its databases and upload markers go with it)
			rmSync(entryPath, { recursive: true });
		} else if (
			entry.name.endsWith(".db") ||
			entry.name.endsWith(".db-wal") ||
			entry.name.endsWith(".db-shm") ||
			entry.name.endsWith(".awaiting-upload")
		) {
			unlinkSync(entryPath);
		}
	}
}

export function getDbCacheSize(): number {
	return dbCache.size;
}

export function dbExists(dbName: string): boolean {
	if (IN_MEMORY) return dbCache.has(dbName);
	return existsSync(dbPathOf(dbName));
}
