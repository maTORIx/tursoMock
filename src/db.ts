// Embedded libSQL (native) instead of bun:sqlite so the mock exposes libSQL's
// native vector search (F32_BLOB / vector32 / vector_distance_cos /
// libsql_vector_idx / vector_top_k), matching production Turso semantics.
// better-sqlite3-compatible synchronous API.
import Database from "libsql";
import { existsSync, mkdirSync, unlinkSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

let DB_DIR = "./db";

// Database connection cache
const dbCache: Map<string, Database> = new Map();

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

export function closeDb(dbName: string): void {
	const db = dbCache.get(dbName);
	if (db) {
		db.close();
		dbCache.delete(dbName);
	}
}

export function closeAllDbs(): void {
	for (const [name, db] of dbCache) {
		db.close();
	}
	dbCache.clear();
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
