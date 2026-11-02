// Embedded libSQL (native) instead of bun:sqlite so the mock exposes libSQL's
// native vector search (F32_BLOB / vector32 / vector_distance_cos /
// libsql_vector_idx / vector_top_k), matching production Turso semantics.
// better-sqlite3-compatible synchronous API.
import Database from "libsql";
import { existsSync, mkdirSync, rmSync, unlinkSync, readdirSync } from "fs";
import { dirname, join } from "path";

let DB_DIR = "./db";
let IN_MEMORY = false;

// Database connection cache
const dbCache: Map<string, Database> = new Map();

// SQL storage for sql_id references
export const sqlStorage: Map<string, Map<number, string>> = new Map();

/**
 * Keep every database in process memory instead of on disk. Data is gone when
 * the server stops; intended for test suites, where it removes the fsync cost
 * of each autocommit write.
 */
export function setInMemory(enabled: boolean): void {
	IN_MEMORY = enabled;
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

function prepareDbPath(dbName: string): string {
	const dbPath = join(DB_DIR, `${dbName}.db`);
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
			// Namespace directory
			rmSync(entryPath, { recursive: true });
		} else if (entry.name.endsWith(".db") || entry.name.endsWith(".db-wal") || entry.name.endsWith(".db-shm")) {
			unlinkSync(entryPath);
		}
	}
}

export function getDbCacheSize(): number {
	return dbCache.size;
}

export function dbExists(dbName: string): boolean {
	if (IN_MEMORY) return dbCache.has(dbName);
	const dbPath = join(DB_DIR, `${dbName}.db`);
	return existsSync(dbPath);
}
