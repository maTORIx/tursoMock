import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, MOCK_PLATFORM_TOKEN } from "../src/server";

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_PORT = 18082;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-hrana");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;
const dbName = `hrana-test-${Date.now()}`;

beforeAll(async () => {
	if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	setDbDir(TEST_DB_DIR);

	const serverConfig = createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR });
	server = Bun.serve(serverConfig);

	await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ name: dbName, group: "mock" }),
	});
});

afterAll(() => {
	closeAllDbs();
	server.stop();
	if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
});

async function pipeline(requests: unknown[], version: "v2" | "v3" = "v2") {
	const resp = await fetch(`${MOCK_SERVER_URL}/${dbName}/${version}/pipeline`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requests }),
	});
	return { status: resp.status, body: await resp.json() };
}

describe("Hrana version check endpoints", () => {
	it("GET /v2 returns ok", async () => {
		const resp = await fetch(`${MOCK_SERVER_URL}/v2`);
		expect(resp.ok).toBe(true);
	});

	it("GET /v3 returns ok", async () => {
		const resp = await fetch(`${MOCK_SERVER_URL}/v3`);
		expect(resp.ok).toBe(true);
	});
});

describe("Hrana sequence request", () => {
	it("executes semicolon-separated SQL", async () => {
		const { body } = await pipeline([
			{
				type: "sequence",
				sql: "CREATE TABLE IF NOT EXISTS seq_t (id INTEGER); INSERT INTO seq_t VALUES (1); INSERT INTO seq_t VALUES (2);",
			},
			{
				type: "execute",
				stmt: { sql: "SELECT COUNT(*) as c FROM seq_t" },
			},
		]);
		expect(body.results[0].type).toBe("ok");
		expect(body.results[0].response.type).toBe("sequence");
		expect(body.results[1].response.result.rows[0][0].value).toBe("2");
	});

	it("sequence via sql_id reference", async () => {
		const { body } = await pipeline([
			{
				type: "store_sql",
				sql_id: 100,
				sql: "CREATE TABLE IF NOT EXISTS seq_t2 (id INTEGER); INSERT INTO seq_t2 VALUES (42);",
			},
			{ type: "sequence", sql_id: 100 },
			{ type: "execute", stmt: { sql: "SELECT id FROM seq_t2" } },
		]);
		expect(body.results[1].type).toBe("ok");
		expect(body.results[2].response.result.rows[0][0].value).toBe("42");
	});
});

describe("Hrana describe request", () => {
	beforeAll(async () => {
		await pipeline([
			{
				type: "execute",
				stmt: {
					sql: "CREATE TABLE IF NOT EXISTS desc_t (id INTEGER PRIMARY KEY, name TEXT)",
				},
			},
		]);
	});

	it("returns params and cols for SELECT", async () => {
		const { body } = await pipeline([
			{ type: "describe", sql: "SELECT id, name FROM desc_t WHERE id = ?" },
		]);
		expect(body.results[0].type).toBe("ok");
		const res = body.results[0].response.result;
		expect(Array.isArray(res.params)).toBe(true);
		expect(Array.isArray(res.cols)).toBe(true);
		expect(res.cols.length).toBe(2);
		expect(res.cols[0].name).toBe("id");
		expect(res.cols[1].name).toBe("name");
		expect(typeof res.is_explain).toBe("boolean");
		expect(typeof res.is_readonly).toBe("boolean");
		expect(res.is_readonly).toBe(true);
	});

	it("marks writes as not readonly", async () => {
		const { body } = await pipeline([
			{ type: "describe", sql: "INSERT INTO desc_t (name) VALUES (?)" },
		]);
		expect(body.results[0].response.result.is_readonly).toBe(false);
	});
});

describe("Hrana close_sql request", () => {
	it("removes stored SQL", async () => {
		const { body: stored } = await pipeline([
			{ type: "store_sql", sql_id: 200, sql: "SELECT 1" },
			{ type: "close_sql", sql_id: 200 },
		]);
		expect(stored.results[0].type).toBe("ok");
		expect(stored.results[1].type).toBe("ok");
		expect(stored.results[1].response.type).toBe("close_sql");

		// using the sql_id after close should error
		const { body: after } = await pipeline([
			{ type: "execute", stmt: { sql_id: 200 } },
		]);
		expect(after.results[0].type).toBe("error");
	});
});

describe("Hrana get_autocommit request", () => {
	it("returns is_autocommit boolean", async () => {
		const { body } = await pipeline([{ type: "get_autocommit" }]);
		expect(body.results[0].type).toBe("ok");
		expect(body.results[0].response.type).toBe("get_autocommit");
		expect(typeof body.results[0].response.is_autocommit).toBe("boolean");
	});
});

describe("Hrana StmtResult extra fields", () => {
	it("includes rows_read, rows_written, query_duration_ms", async () => {
		await pipeline([
			{
				type: "execute",
				stmt: { sql: "CREATE TABLE IF NOT EXISTS stats_t (id INTEGER)" },
			},
			{ type: "execute", stmt: { sql: "INSERT INTO stats_t VALUES (1)" } },
		]);

		const { body } = await pipeline([
			{ type: "execute", stmt: { sql: "SELECT * FROM stats_t" } },
		]);
		const result = body.results[0].response.result;
		expect(typeof result.rows_read).toBe("number");
		expect(typeof result.rows_written).toBe("number");
		expect(typeof result.query_duration_ms).toBe("number");
	});
});

describe("Hrana v3 pipeline endpoint", () => {
	it("works at /v3/pipeline", async () => {
		const { status, body } = await pipeline(
			[{ type: "execute", stmt: { sql: "SELECT 1 as v" } }],
			"v3"
		);
		expect(status).toBe(200);
		expect(body.results[0].type).toBe("ok");
		expect(body.results[0].response.result.rows[0][0].value).toBe("1");
	});
});
