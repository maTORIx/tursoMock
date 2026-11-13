import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer, MOCK_PLATFORM_TOKEN, MOCK_DB_JWT, MOCK_DB_JWT_READ_ONLY } from "../src/server";
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

/**
 * read-only トークンの接続は SQLite の側で書き込みを拒む (文の先頭の語では判定しない)。
 * execute / batch / sequence のどの経路でも、CTE や複文に紛れた書き込みが通らないこと。
 */

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
const TEST_PORT = 18089;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-readonly");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;
let name = "";
let seq = 0;

beforeAll(() => {
	if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	setDbDir(TEST_DB_DIR);
	server = Bun.serve(createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR }));
});

afterAll(() => {
	closeAllDbs();
	server.stop();
	if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
});

type Result = { type: "ok"; response: any } | { type: "error"; error: { message: string } };

async function pipeline(token: string, requests: unknown[]): Promise<Result[]> {
	const res = await fetch(`${MOCK_SERVER_URL}/${name}/v2/pipeline`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ requests }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { results: Result[] }).results;
}

const execute = (token: string, sql: string) => pipeline(token, [{ type: "execute", stmt: { sql } }]);

async function count(): Promise<number> {
	const [r] = await execute(MOCK_DB_JWT, "SELECT count(*) AS n FROM t");
	if (r.type !== "ok") throw new Error(r.error.message);
	return Number(r.response.result.rows[0][0].value);
}

/** 1 テスト 1 つの DB (行が 2 つ) */
beforeEach(async () => {
	name = `ro-${Date.now()}-${seq++}`;
	await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ name }),
	});
	await pipeline(MOCK_DB_JWT, [
		{ type: "execute", stmt: { sql: "CREATE TABLE t (x INTEGER)" } },
		{ type: "execute", stmt: { sql: "INSERT INTO t VALUES (1), (2)" } },
	]);
});

describe("read-only トークンの書き込みの拒否", () => {
	it("execute の CTE 付き DELETE を拒み、行は消えない", async () => {
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "WITH a AS (SELECT 1) DELETE FROM t");
		expect(r.type).toBe("error");
		expect(await count()).toBe(2);
	});

	it("execute の複文 (SELECT のあとの DELETE) を拒み、行は消えない", async () => {
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "SELECT 1; DELETE FROM t");
		expect(r.type).toBe("error");
		expect(await count()).toBe(2);
	});

	it("sequence の複文 (SELECT のあとの DELETE) を拒み、行は消えない", async () => {
		const [r] = await pipeline(MOCK_DB_JWT_READ_ONLY, [{ type: "sequence", sql: "SELECT 1; DELETE FROM t" }]);
		expect(r.type).toBe("error");
		expect(await count()).toBe(2);
	});

	it("batch の段の CTE 付き DELETE を拒み、行は消えない", async () => {
		const [r] = await pipeline(MOCK_DB_JWT_READ_ONLY, [
			{ type: "batch", batch: { steps: [{ stmt: { sql: "WITH a AS (SELECT 1) DELETE FROM t" } }] } },
		]);
		expect(r.type).toBe("ok");
		if (r.type !== "ok") return;
		expect(r.response.result.step_results).toEqual([null]);
		expect(r.response.result.step_errors[0].message).toMatch(/readonly|read-only/i);
		expect(await count()).toBe(2);
	});

	it("INSERT を拒み、行は増えない", async () => {
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "INSERT INTO t VALUES (3)");
		expect(r.type).toBe("error");
		expect(await count()).toBe(2);
	});

	it("PRAGMA query_only を切っても書き込めない", async () => {
		const [r] = await pipeline(MOCK_DB_JWT_READ_ONLY, [
			{ type: "sequence", sql: "PRAGMA query_only = 0; DELETE FROM t" },
		]);
		expect(r.type).toBe("error");
		expect(await count()).toBe(2);
	});

	it("対照: 書き込めるトークンなら同じ CTE 付き DELETE が通る", async () => {
		const [r] = await execute(MOCK_DB_JWT, "WITH a AS (SELECT 1) DELETE FROM t");
		expect(r.type).toBe("ok");
		expect(await count()).toBe(0);
	});
});

describe("read-only トークンの読み取り", () => {
	it("SELECT が通る", async () => {
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "SELECT x FROM t ORDER BY x");
		expect(r.type).toBe("ok");
		if (r.type !== "ok") return;
		expect(r.response.result.rows.map((row: any[]) => row[0].value)).toEqual(["1", "2"]);
	});

	it("CTE 付きの SELECT が通る", async () => {
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "WITH a AS (SELECT x FROM t WHERE x > 1) SELECT x FROM a");
		expect(r.type).toBe("ok");
		if (r.type !== "ok") return;
		expect(r.response.result.rows.map((row: any[]) => row[0].value)).toEqual(["2"]);
	});

	it("batch の BEGIN / SELECT / COMMIT が通る (読み取りのトランザクション)", async () => {
		const [r] = await pipeline(MOCK_DB_JWT_READ_ONLY, [
			{
				type: "batch",
				batch: {
					steps: [
						{ stmt: { sql: "BEGIN DEFERRED" } },
						{ stmt: { sql: "SELECT count(*) FROM t" } },
						{ stmt: { sql: "COMMIT" } },
					],
				},
			},
		]);
		expect(r.type).toBe("ok");
		if (r.type !== "ok") return;
		expect(r.response.result.step_errors).toEqual([null, null, null]);
		expect(r.response.result.step_results[1].rows[0][0].value).toBe("2");
	});

	it("ベクトル索引 (vector_top_k) を引ける", async () => {
		await pipeline(MOCK_DB_JWT, [
			{ type: "execute", stmt: { sql: "CREATE TABLE v (id INTEGER PRIMARY KEY, e F32_BLOB(2))" } },
			{ type: "execute", stmt: { sql: "CREATE INDEX v_idx ON v(libsql_vector_idx(e))" } },
			{ type: "execute", stmt: { sql: "INSERT INTO v VALUES (1, vector32('[1,0]')), (2, vector32('[0,1]'))" } },
		]);
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "SELECT id FROM vector_top_k('v_idx', vector32('[0,1]'), 1)");
		expect(r.type).toBe("ok");
		if (r.type !== "ok") return;
		expect(r.response.result.rows[0][0].value).toBe("2");
	});

	it("あとから書き込まれた行も読める (読み取りの接続が古い中身を持ち続けない)", async () => {
		await execute(MOCK_DB_JWT_READ_ONLY, "SELECT count(*) FROM t");
		await execute(MOCK_DB_JWT, "INSERT INTO t VALUES (3)");
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "SELECT count(*) FROM t");
		expect(r.type).toBe("ok");
		if (r.type !== "ok") return;
		expect(r.response.result.rows[0][0].value).toBe("3");
	});

	it("DB を消して作り直すと、read-only でも新しい中身を読む", async () => {
		await execute(MOCK_DB_JWT_READ_ONLY, "SELECT count(*) FROM t");
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${name}`, { method: "DELETE", headers: AUTH });
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...AUTH },
			body: JSON.stringify({ name }),
		});
		await execute(MOCK_DB_JWT, "CREATE TABLE u (y INTEGER)");
		const [r] = await execute(MOCK_DB_JWT_READ_ONLY, "SELECT count(*) FROM u");
		expect(r.type).toBe("ok");
	});
});
