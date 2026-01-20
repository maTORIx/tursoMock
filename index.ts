import { Hono } from "hono";
import { cors } from "hono/cors";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";

const app = new Hono();
const DB_DIR = join(import.meta.dir, "db");
const PORT = 8080;

// Ensure db directory exists
if (!existsSync(DB_DIR)) {
	mkdirSync(DB_DIR, { recursive: true });
}

// Database connection cache
const dbCache: Map<string, Database> = new Map();

function getDb(dbName: string): Database {
	if (dbCache.has(dbName)) {
		return dbCache.get(dbName)!;
	}
	const dbPath = join(DB_DIR, `${dbName}.db`);
	const db = new Database(dbPath);
	dbCache.set(dbName, db);
	return db;
}

function closeDb(dbName: string): void {
	const db = dbCache.get(dbName);
	if (db) {
		db.close();
		dbCache.delete(dbName);
	}
}

app.use("*", cors());

// ============================================
// Turso Management API Mock
// ============================================

// Create database
app.post("/v1/organizations/:org/databases", async (c) => {
	const body = await c.req.json<{ name: string; group: string }>();
	const dbName = body.name;

	const dbPath = join(DB_DIR, `${dbName}.db`);
	if (existsSync(dbPath)) {
		return c.json({ error: "database already exists" }, 409);
	}

	// Create empty database file
	const db = getDb(dbName);
	db.exec("SELECT 1"); // Initialize

	return c.json({
		database: {
			DbId: `mock-${dbName}-${Date.now()}`,
			HostName: `${dbName}.localhost:${PORT}`,
			Name: dbName,
		},
	});
});

// Delete database
app.delete("/v1/organizations/:org/databases/:name", async (c) => {
	const dbName = c.req.param("name");
	const dbPath = join(DB_DIR, `${dbName}.db`);

	closeDb(dbName);

	if (existsSync(dbPath)) {
		unlinkSync(dbPath);
		// Also remove WAL and SHM files if they exist
		const walPath = `${dbPath}-wal`;
		const shmPath = `${dbPath}-shm`;
		if (existsSync(walPath)) unlinkSync(walPath);
		if (existsSync(shmPath)) unlinkSync(shmPath);
	}

	return c.json({ success: true });
});

// List databases
app.get("/v1/organizations/:org/databases", async (c) => {
	const files = readdirSync(DB_DIR).filter((f) => f.endsWith(".db"));
	const databases = files.map((f) => ({
		Name: f.replace(".db", ""),
		DbId: `mock-${f.replace(".db", "")}`,
		HostName: `${f.replace(".db", "")}.localhost:${PORT}`,
	}));
	return c.json({ databases });
});

// ============================================
// libsql HTTP Protocol (Hrana v2)
// ============================================

interface HranaValue {
	type: "integer" | "float" | "text" | "blob" | "null";
	value?: string | number;
}

interface HranaStatement {
	sql?: string;
	sql_id?: number;
	args?: HranaValue[];
	named_args?: { name: string; value: HranaValue }[];
	want_rows?: boolean;
}

interface HranaBatchStep {
	stmt: HranaStatement;
	condition?: {
		type: "ok" | "not" | "and" | "or" | "is_autocommit";
		step?: number;
		cond?: any;
		conds?: any[];
	};
}

interface HranaRequest {
	type: "execute" | "close" | "batch" | "store_sql";
	stmt?: HranaStatement;
	batch?: { steps: HranaBatchStep[] };
	sql_id?: number;
	sql?: string;
}

interface HranaPipelineRequest {
	requests: HranaRequest[];
}

// SQL storage for sql_id references
const sqlStorage: Map<string, Map<number, string>> = new Map();

function convertHranaValue(val: HranaValue): unknown {
	if (val.type === "null") return null;
	if (val.type === "integer") return BigInt(val.value as string);
	if (val.type === "float") return Number(val.value);
	if (val.type === "text") return val.value;
	if (val.type === "blob") return Buffer.from(val.value as string, "base64");
	return val.value;
}

function toHranaValue(val: unknown): HranaValue {
	if (val === null || val === undefined) {
		return { type: "null" };
	}
	if (typeof val === "bigint") {
		return { type: "integer", value: String(val) };
	}
	if (typeof val === "number") {
		if (Number.isInteger(val)) {
			return { type: "integer", value: String(val) };
		}
		return { type: "float", value: val };
	}
	if (typeof val === "string") {
		return { type: "text", value: val };
	}
	if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
		return { type: "blob", value: Buffer.from(val).toString("base64") };
	}
	return { type: "text", value: String(val) };
}

function executeStatement(db: Database, stmt: HranaStatement, dbName: string) {
	const args: unknown[] = [];

	if (stmt.args) {
		for (const arg of stmt.args) {
			args.push(convertHranaValue(arg));
		}
	}

	// Resolve SQL from sql_id if needed
	let sql = stmt.sql;
	if (sql === undefined && stmt.sql_id !== undefined) {
		const dbSqlStorage = sqlStorage.get(dbName);
		if (dbSqlStorage) {
			sql = dbSqlStorage.get(stmt.sql_id);
		}
		if (!sql) {
			throw new Error(`SQL with id ${stmt.sql_id} not found`);
		}
	}
	if (!sql) {
		throw new Error("No SQL statement provided");
	}

	const sqlTrimmed = sql.trim();
	const sqlUpper = sqlTrimmed.toUpperCase();
	const isSelect = sqlUpper.startsWith("SELECT") || sqlUpper.startsWith("PRAGMA");

	// Check if this is a multi-statement SQL (for DDL like schema creation)
	// Count semicolons that are not inside strings (simplified check)
	const hasMultipleStatements = (sqlTrimmed.match(/;/g) || []).length > 1 ||
		(sqlTrimmed.includes(";") && !sqlTrimmed.endsWith(";"));

	try {
		// For multi-statement DDL without parameters, use exec()
		if (hasMultipleStatements && args.length === 0 && (!stmt.named_args || stmt.named_args.length === 0)) {
			db.exec(sqlTrimmed);
			return {
				cols: [],
				rows: [],
				affected_row_count: 0,
				last_insert_rowid: null,
			};
		}

		if (stmt.named_args && stmt.named_args.length > 0) {
			const namedArgs: Record<string, unknown> = {};
			for (const arg of stmt.named_args) {
				namedArgs[`$${arg.name}`] = convertHranaValue(arg.value);
			}

			const prepared = db.prepare(sql);

			if (isSelect) {
				const rows = prepared.all(namedArgs) as Record<string, unknown>[];
				const cols =
					rows.length > 0
						? Object.keys(rows[0]).map((name) => ({ name, decltype: null }))
						: [];

				return {
					cols,
					rows: rows.map((row) => Object.values(row).map(toHranaValue)),
					affected_row_count: 0,
					last_insert_rowid: null,
				};
			} else {
				const result = prepared.run(namedArgs);
				return {
					cols: [],
					rows: [],
					affected_row_count: result.changes,
					last_insert_rowid: result.lastInsertRowid
						? String(result.lastInsertRowid)
						: null,
				};
			}
		}

		const prepared = db.prepare(sql);

		if (isSelect) {
			const rows = prepared.all(...args) as Record<string, unknown>[];
			const cols =
				rows.length > 0
					? Object.keys(rows[0]).map((name) => ({ name, decltype: null }))
					: [];

			return {
				cols,
				rows: rows.map((row) => Object.values(row).map(toHranaValue)),
				affected_row_count: 0,
				last_insert_rowid: null,
			};
		} else {
			const result = prepared.run(...args);
			return {
				cols: [],
				rows: [],
				affected_row_count: result.changes,
				last_insert_rowid: result.lastInsertRowid
					? String(result.lastInsertRowid)
					: null,
			};
		}
	} catch (e) {
		throw e;
	}
}

// Check if a batch step condition is met
function checkCondition(
	condition: HranaBatchStep["condition"],
	stepResults: ({ ok: boolean } | null)[]
): boolean {
	if (!condition) return true;

	switch (condition.type) {
		case "ok":
			return stepResults[condition.step!]?.ok === true;
		case "not":
			return !checkCondition(condition.cond, stepResults);
		case "and":
			return condition.conds!.every((c: any) => checkCondition(c, stepResults));
		case "or":
			return condition.conds!.some((c: any) => checkCondition(c, stepResults));
		case "is_autocommit":
			return true; // Always in autocommit mode for simplicity
		default:
			return true;
	}
}

// Hrana v2 pipeline endpoint
// Supports two patterns:
// 1. Subdomain: http://dbname.localhost:8080/v2/pipeline (preferred for libsql client)
// 2. Path: http://localhost:8080/dbname/v2/pipeline (for curl testing)
app.post("/v2/pipeline", async (c) => {
	const host = c.req.header("host") || "";
	// Extract db name from subdomain (e.g., "testdb.localhost:8080" -> "testdb")
	const hostParts = host.split(".");
	const dbName = hostParts.length > 1 ? hostParts[0] : "default";

	const body = await c.req.json<HranaPipelineRequest>();

	const db = getDb(dbName);
	const results: unknown[] = [];

	// Initialize SQL storage for this database if not exists
	if (!sqlStorage.has(dbName)) {
		sqlStorage.set(dbName, new Map());
	}
	const dbSqlStorage = sqlStorage.get(dbName)!;

	for (const request of body.requests) {
		try {
			if (request.type === "store_sql") {
				// Store SQL for later use with sql_id
				dbSqlStorage.set(request.sql_id!, request.sql!);
				results.push({
					type: "ok",
					response: { type: "store_sql" },
				});
			} else if (request.type === "execute" && request.stmt) {
				const result = executeStatement(db, request.stmt, dbName);
				results.push({
					type: "ok",
					response: {
						type: "execute",
						result,
					},
				});
			} else if (request.type === "batch" && request.batch) {
				const stepResults: ({ ok: boolean } | null)[] = [];
				const batchStepResults: (any | null)[] = [];
				const batchStepErrors: (any | null)[] = [];

				for (let i = 0; i < request.batch.steps.length; i++) {
					const step = request.batch.steps[i];

					// Check condition
					if (!checkCondition(step.condition, stepResults)) {
						stepResults.push(null);
						batchStepResults.push(null);
						batchStepErrors.push(null);
						continue;
					}

					try {
						const result = executeStatement(db, step.stmt, dbName);
						stepResults.push({ ok: true });
						batchStepResults.push(result);
						batchStepErrors.push(null);
					} catch (e) {
						const error = e as Error;
						stepResults.push({ ok: false });
						batchStepResults.push(null);
						batchStepErrors.push({
							message: error.message,
							code: "SQLITE_ERROR",
						});
					}
				}

				results.push({
					type: "ok",
					response: {
						type: "batch",
						result: {
							step_results: batchStepResults,
							step_errors: batchStepErrors,
						},
					},
				});
			} else if (request.type === "close") {
				// Clear SQL storage for this database on close
				sqlStorage.delete(dbName);
				results.push({
					type: "ok",
					response: { type: "close" },
				});
			}
		} catch (e) {
			const error = e as Error;
			results.push({
				type: "error",
				error: {
					message: error.message,
					code: "SQLITE_ERROR",
				},
			});
		}
	}
	return c.json({
		baton: null,
		base_url: null,
		results,
	});
});

// Path-based pipeline (for testing convenience)
app.post("/:dbName/v2/pipeline", async (c) => {
	const dbName = c.req.param("dbName");
	const body = await c.req.json<HranaPipelineRequest>();

	const db = getDb(dbName);
	const results: unknown[] = [];

	// Initialize SQL storage for this database if not exists
	if (!sqlStorage.has(dbName)) {
		sqlStorage.set(dbName, new Map());
	}
	const dbSqlStorage = sqlStorage.get(dbName)!;

	for (const request of body.requests) {
		try {
			if (request.type === "store_sql") {
				dbSqlStorage.set(request.sql_id!, request.sql!);
				results.push({
					type: "ok",
					response: { type: "store_sql" },
				});
			} else if (request.type === "execute" && request.stmt) {
				const result = executeStatement(db, request.stmt, dbName);
				results.push({
					type: "ok",
					response: {
						type: "execute",
						result,
					},
				});
			} else if (request.type === "batch" && request.batch) {
				const stepResults: ({ ok: boolean } | null)[] = [];
				const batchStepResults: (any | null)[] = [];
				const batchStepErrors: (any | null)[] = [];

				for (let i = 0; i < request.batch.steps.length; i++) {
					const step = request.batch.steps[i];

					if (!checkCondition(step.condition, stepResults)) {
						stepResults.push(null);
						batchStepResults.push(null);
						batchStepErrors.push(null);
						continue;
					}

					try {
						const result = executeStatement(db, step.stmt, dbName);
						stepResults.push({ ok: true });
						batchStepResults.push(result);
						batchStepErrors.push(null);
					} catch (e) {
						const error = e as Error;
						stepResults.push({ ok: false });
						batchStepResults.push(null);
						batchStepErrors.push({
							message: error.message,
							code: "SQLITE_ERROR",
						});
					}
				}

				results.push({
					type: "ok",
					response: {
						type: "batch",
						result: {
							step_results: batchStepResults,
							step_errors: batchStepErrors,
						},
					},
				});
			} else if (request.type === "close") {
				sqlStorage.delete(dbName);
				results.push({
					type: "ok",
					response: { type: "close" },
				});
			}
		} catch (e) {
			const error = e as Error;
			results.push({
				type: "error",
				error: {
					message: error.message,
					code: "SQLITE_ERROR",
				},
			});
		}
	}

	return c.json({
		baton: null,
		base_url: null,
		results,
	});
});

// Health check
app.get("/health", (c) => {
	return c.json({ status: "ok", databases: dbCache.size });
});

console.log(`Turso Mock Server running on http://localhost:${PORT}`);
console.log(`DB directory: ${DB_DIR}`);
console.log(`Use subdomain format: http://<dbname>.localhost:${PORT}`);

export default {
	port: PORT,
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
