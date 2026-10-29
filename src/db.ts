// Embedded libSQL (native) instead of bun:sqlite so the mock exposes libSQL's
// native vector search (F32_BLOB / vector32 / vector_distance_cos /
// libsql_vector_idx / vector_top_k), matching production Turso semantics.
// better-sqlite3-compatible synchronous API.
import Database from "libsql";
import { existsSync, mkdirSync, unlinkSync, readdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

let DB_DIR = "./db";

// Database connection cache
const dbCache: Map<string, Database> = new Map();
// read-only トークン用の接続 (SQLITE_OPEN_READONLY)。SQL の中身にかかわらず SQLite が書き込みを拒む
const readOnlyCache: Map<string, Database> = new Map();

// SQL storage for sql_id references
export const sqlStorage: Map<string, Map<number, string>> = new Map();

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

export function getDb(dbName: string): Database {
	if (dbCache.has(dbName)) {
		return dbCache.get(dbName)!;
	}
	ensureDbDir();
	const dbPath = join(DB_DIR, `${dbName}.db`);
	const db = new Database(dbPath);
	dbCache.set(dbName, db);
	return db;
}

/**
 * read-only トークンの接続。`mode=ro` で開くので、CTE や複文に紛れた書き込みも
 * `PRAGMA query_only = 0` も SQLite が SQLITE_READONLY で拒む (文の先頭の語では判定しない)。
 * ファイルは書ける接続 (getDb) が先に作る。
 */
export function getReadOnlyDb(dbName: string): Database {
	const cached = readOnlyCache.get(dbName);
	if (cached) return cached;
	getDb(dbName);
	const path = resolve(DB_DIR, `${dbName}.db`).replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
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
	const dbPath = join(DB_DIR, `${dbName}.db`);
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

function uploadMarker(dbName: string): string {
	return join(DB_DIR, `${dbName}.awaiting-upload`);
}

/** A database created with `seed: database_upload` accepts one /v1/upload. */
export function markAwaitingUpload(dbName: string): void {
	ensureDbDir();
	writeFileSync(uploadMarker(dbName), "");
}

export function isAwaitingUpload(dbName: string): boolean {
	return existsSync(uploadMarker(dbName));
}

/** Swap the database file for an uploaded one (closes the cached handle first). */
export function replaceDbFile(dbName: string, bytes: Uint8Array): void {
	closeDb(dbName);
	const dbPath = join(DB_DIR, `${dbName}.db`);
	for (const p of [`${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(p)) unlinkSync(p);
	writeFileSync(dbPath, bytes);
	unlinkSync(uploadMarker(dbName));
}

export function listDatabases(): string[] {
	ensureDbDir();
	return readdirSync(DB_DIR)
		.filter((f) => f.endsWith(".db"))
		.map((f) => f.replace(".db", ""));
}

export function resetAllDbs(): void {
	closeAllDbs();
	ensureDbDir();
	const files = readdirSync(DB_DIR);
	for (const file of files) {
		const filePath = join(DB_DIR, file);
		if (
			file.endsWith(".db") ||
			file.endsWith(".db-wal") ||
			file.endsWith(".db-shm") ||
			file.endsWith(".awaiting-upload")
		) {
			unlinkSync(filePath);
		}
	}
}

export function getDbCacheSize(): number {
	return dbCache.size;
}

export function dbExists(dbName: string): boolean {
	const dbPath = join(DB_DIR, `${dbName}.db`);
	return existsSync(dbPath);
}
