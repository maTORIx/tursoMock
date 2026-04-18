import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { Database } from "bun:sqlite";
import {
	getDb,
	closeDb,
	deleteDbFiles,
	listDatabases,
	getDbCacheSize,
	dbExists,
	sqlStorage,
} from "./db";
import type {
	HranaValue,
	HranaStatement,
	HranaBatchStep,
	HranaPipelineRequest,
	HranaRequest,
	ServerConfig,
} from "./types";

const DB_NAME_RE = /^[a-z0-9-]{1,64}$/;

export const MOCK_PLATFORM_TOKEN = "mock-platform-token";
export const MOCK_DB_JWT = "mock-db-jwt-token";

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

function resolveSql(stmt: HranaStatement, dbName: string): string {
	let sql = stmt.sql;
	if (sql === undefined && stmt.sql_id !== undefined) {
		const dbSqlStorage = sqlStorage.get(dbName);
		sql = dbSqlStorage?.get(stmt.sql_id);
		if (!sql) {
			throw new Error(`SQL with id ${stmt.sql_id} not found`);
		}
	}
	if (!sql) {
		throw new Error("No SQL statement provided");
	}
	return sql;
}

function baseStmtResult() {
	return {
		cols: [] as { name: string; decltype: string | null }[],
		rows: [] as HranaValue[][],
		affected_row_count: 0,
		last_insert_rowid: null as string | null,
		rows_read: 0,
		rows_written: 0,
		query_duration_ms: 0,
	};
}

function executeStatement(db: Database, stmt: HranaStatement, dbName: string) {
	const args: unknown[] = [];

	if (stmt.args) {
		for (const arg of stmt.args) {
			args.push(convertHranaValue(arg));
		}
	}

	const sql = resolveSql(stmt, dbName);
	const sqlTrimmed = sql.trim();
	const sqlUpper = sqlTrimmed.toUpperCase();
	const isSelect = sqlUpper.startsWith("SELECT") || sqlUpper.startsWith("PRAGMA");

	const hasMultipleStatements =
		(sqlTrimmed.match(/;/g) || []).length > 1 ||
		(sqlTrimmed.includes(";") && !sqlTrimmed.endsWith(";"));

	const start = performance.now();

	if (
		hasMultipleStatements &&
		args.length === 0 &&
		(!stmt.named_args || stmt.named_args.length === 0)
	) {
		db.exec(sqlTrimmed);
		const result = baseStmtResult();
		result.query_duration_ms = performance.now() - start;
		return result;
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
			const result = baseStmtResult();
			result.cols = cols;
			result.rows = rows.map((row) => Object.values(row).map(toHranaValue));
			result.rows_read = rows.length;
			result.query_duration_ms = performance.now() - start;
			return result;
		}

		const runResult = prepared.run(namedArgs);
		const result = baseStmtResult();
		result.affected_row_count = runResult.changes;
		result.last_insert_rowid = runResult.lastInsertRowid
			? String(runResult.lastInsertRowid)
			: null;
		result.rows_written = runResult.changes;
		result.query_duration_ms = performance.now() - start;
		return result;
	}

	const prepared = db.prepare(sql);

	if (isSelect) {
		const rows = prepared.all(...args) as Record<string, unknown>[];
		const cols =
			rows.length > 0
				? Object.keys(rows[0]).map((name) => ({ name, decltype: null }))
				: [];
		const result = baseStmtResult();
		result.cols = cols;
		result.rows = rows.map((row) => Object.values(row).map(toHranaValue));
		result.rows_read = rows.length;
		result.query_duration_ms = performance.now() - start;
		return result;
	}

	const runResult = prepared.run(...args);
	const result = baseStmtResult();
	result.affected_row_count = runResult.changes;
	result.last_insert_rowid = runResult.lastInsertRowid
		? String(runResult.lastInsertRowid)
		: null;
	result.rows_written = runResult.changes;
	result.query_duration_ms = performance.now() - start;
	return result;
}

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
			return condition.conds!.every((c) => checkCondition(c, stepResults));
		case "or":
			return condition.conds!.some((c) => checkCondition(c, stepResults));
		case "is_autocommit":
			return true;
		default:
			return true;
	}
}

function describeSql(db: Database, sql: string) {
	const trimmed = sql.trim();
	const upper = trimmed.toUpperCase();
	const isExplain = upper.startsWith("EXPLAIN");
	const isReadonly =
		upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || isExplain;

	// Count positional params (naive but adequate for a mock)
	const positional = (sql.match(/\?/g) || []).length;
	const namedMatches = sql.match(/[@:$][a-zA-Z_][a-zA-Z0-9_]*/g) || [];
	const params = [
		...Array(positional).fill({ name: null }),
		...namedMatches.map((n) => ({ name: n })),
	];

	let cols: { name: string; decltype: string | null }[] = [];
	if (isReadonly) {
		try {
			const prepared = db.prepare(sql);
			const colNames = prepared.columnNames;
			cols = colNames.map((name) => ({ name, decltype: null }));
		} catch {
			cols = [];
		}
	}

	return {
		params,
		cols,
		is_explain: isExplain,
		is_readonly: isReadonly,
	};
}

function handleRequest(
	request: HranaRequest,
	dbName: string,
	dbSqlStorage: Map<number, string>
): unknown {
	const db = getDb(dbName);

	switch (request.type) {
		case "store_sql": {
			dbSqlStorage.set(request.sql_id!, request.sql!);
			return { type: "ok", response: { type: "store_sql" } };
		}

		case "close_sql": {
			dbSqlStorage.delete(request.sql_id!);
			return { type: "ok", response: { type: "close_sql" } };
		}

		case "execute": {
			const result = executeStatement(db, request.stmt!, dbName);
			return { type: "ok", response: { type: "execute", result } };
		}

		case "batch": {
			const stepResults: ({ ok: boolean } | null)[] = [];
			const batchStepResults: (unknown | null)[] = [];
			const batchStepErrors: (unknown | null)[] = [];

			for (const step of request.batch!.steps) {
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

			return {
				type: "ok",
				response: {
					type: "batch",
					result: {
						step_results: batchStepResults,
						step_errors: batchStepErrors,
					},
				},
			};
		}

		case "sequence": {
			let sql = request.sql;
			if (sql === undefined && request.sql_id !== undefined) {
				sql = dbSqlStorage.get(request.sql_id);
				if (!sql) {
					throw new Error(`SQL with id ${request.sql_id} not found`);
				}
			}
			if (!sql) throw new Error("No SQL provided for sequence");
			db.exec(sql);
			return { type: "ok", response: { type: "sequence" } };
		}

		case "describe": {
			let sql = request.sql;
			if (sql === undefined && request.sql_id !== undefined) {
				sql = dbSqlStorage.get(request.sql_id);
				if (!sql) {
					throw new Error(`SQL with id ${request.sql_id} not found`);
				}
			}
			if (!sql) throw new Error("No SQL provided for describe");
			const result = describeSql(db, sql);
			return { type: "ok", response: { type: "describe", result } };
		}

		case "get_autocommit": {
			return {
				type: "ok",
				response: { type: "get_autocommit", is_autocommit: true },
			};
		}

		case "close": {
			sqlStorage.delete(dbName);
			return { type: "ok", response: { type: "close" } };
		}
	}

	throw new Error(`Unknown request type: ${(request as HranaRequest).type}`);
}

function handlePipelineRequest(body: HranaPipelineRequest, dbName: string) {
	const results: unknown[] = [];

	if (!sqlStorage.has(dbName)) {
		sqlStorage.set(dbName, new Map());
	}
	const dbSqlStorage = sqlStorage.get(dbName)!;

	for (const request of body.requests) {
		try {
			results.push(handleRequest(request, dbName, dbSqlStorage));
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

	return {
		baton: null,
		base_url: null,
		results,
	};
}

function databaseObject(name: string, port: number) {
	return {
		Name: name,
		DbId: `mock-${name}`,
		Hostname: `${name}.localhost:${port}`,
		block_reads: false,
		block_writes: false,
		regions: [] as string[],
		primaryRegion: "mock",
		group: "default",
		delete_protection: false,
		parent: null as null | { id: string; name: string; branched_at: string },
	};
}

export function createApp(config: ServerConfig) {
	const app = new Hono();
	const { port } = config;

	app.use("*", cors());

	// ============================================
	// Platform API auth middleware (fixed token)
	// ============================================
	app.use("/v1/*", async (c, next) => {
		const header = c.req.header("Authorization") || "";
		const match = header.match(/^Bearer\s+(.+)$/);
		if (!match || match[1] !== MOCK_PLATFORM_TOKEN) {
			return c.json({ error: "unauthorized" }, 401);
		}
		await next();
	});

	// ============================================
	// Turso Management API Mock
	// ============================================

	app.post("/v1/organizations/:org/databases", async (c) => {
		const body = await c.req.json<{ name: string; group?: string }>();
		const dbName = body.name;

		if (!dbName || !DB_NAME_RE.test(dbName)) {
			return c.json(
				{
					error:
						"invalid database name: must be lowercase letters, numbers, dashes, max 64 chars",
				},
				400
			);
		}

		if (dbExists(dbName)) {
			return c.json(
				{ error: `database with name ${dbName} already exists` },
				409
			);
		}

		const db = getDb(dbName);
		db.exec("SELECT 1");

		const obj = databaseObject(dbName, port);
		if (body.group) obj.group = body.group;
		// Create response keeps the legacy minimal shape documented on create
		return c.json({
			database: {
				DbId: `mock-${dbName}-${Date.now()}`,
				Hostname: obj.Hostname,
				Name: dbName,
			},
		});
	});

	app.post("/v1/organizations/:org/databases/:name/auth/tokens", (c) => {
		const dbName = c.req.param("name");
		if (!dbExists(dbName)) {
			return c.json(
				{ error: `could not find database with name ${dbName}` },
				404
			);
		}
		return c.json({ jwt: MOCK_DB_JWT });
	});

	app.get("/v1/organizations/:org/databases/:name", (c) => {
		const dbName = c.req.param("name");
		if (!dbExists(dbName)) {
			return c.json({ error: "database not found" }, 404);
		}
		return c.json({ database: databaseObject(dbName, port) });
	});

	app.delete("/v1/organizations/:org/databases/:name", (c) => {
		const dbName = c.req.param("name");
		closeDb(dbName);
		deleteDbFiles(dbName);
		return c.json({ database: databaseObject(dbName, port) });
	});

	app.get("/v1/organizations/:org/databases", (c) => {
		const databases = listDatabases().map((name) => databaseObject(name, port));
		return c.json({ databases });
	});

	// ============================================
	// Hrana version checks
	// ============================================

	app.get("/v2", (c) => c.text("Hrana v2 (JSON)"));
	app.get("/v3", (c) => c.text("Hrana v3 (JSON)"));

	// ============================================
	// libsql HTTP Protocol (Hrana v2/v3)
	// ============================================

	const subdomainPipeline = async (c: Context) => {
		const host = c.req.header("host") || "";
		const hostParts = host.split(".");
		const dbName = hostParts.length > 1 ? hostParts[0] : "default";
		const body = await c.req.json<HranaPipelineRequest>();
		return c.json(handlePipelineRequest(body, dbName));
	};

	const pathPipeline = async (c: Context) => {
		const dbName = c.req.param("dbName");
		const body = await c.req.json<HranaPipelineRequest>();
		return c.json(handlePipelineRequest(body, dbName));
	};

	app.post("/v2/pipeline", subdomainPipeline);
	app.post("/v3/pipeline", subdomainPipeline);
	app.post("/:dbName/v2/pipeline", pathPipeline);
	app.post("/:dbName/v3/pipeline", pathPipeline);

	app.get("/health", (c) => {
		return c.json({ status: "ok", databases: getDbCacheSize() });
	});

	return app;
}

export function createServer(config: ServerConfig) {
	const app = createApp(config);

	return {
		port: config.port,
		hostname: "0.0.0.0",
		fetch: app.fetch,
	};
}
