import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createClient } from "@libsql/client";
import { createServer } from "../src/server";
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_PORT = 18081;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-batch");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	if (existsSync(TEST_DB_DIR)) {
		rmSync(TEST_DB_DIR, { recursive: true });
	}
	mkdirSync(TEST_DB_DIR, { recursive: true });

	setDbDir(TEST_DB_DIR);

	const serverConfig = createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR });
	server = Bun.serve(serverConfig);
});

afterAll(() => {
	closeAllDbs();
	server.stop();
	if (existsSync(TEST_DB_DIR)) {
		rmSync(TEST_DB_DIR, { recursive: true });
	}
});

describe("Batch Operations", () => {
	const dbName = `batch-test-${Date.now()}`;
	let client: ReturnType<typeof createClient>;

	beforeAll(async () => {
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: dbName, group: "mock" }),
		});
		client = createClient({
			url: `http://${dbName}.localhost:${TEST_PORT}`,
		});
	});

	afterAll(async () => {
		await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${dbName}`,
			{ method: "DELETE" }
		);
	});

	it("should execute batch with write mode", async () => {
		// Create table first
		await client.execute(
			"CREATE TABLE IF NOT EXISTS test (id TEXT, value TEXT)"
		);

		// Test batch with write mode
		await client.batch(
			[
				{ sql: "INSERT INTO test VALUES (?, ?)", args: ["1", "a"] },
				{ sql: "INSERT INTO test VALUES (?, ?)", args: ["2", "b"] },
			],
			"write"
		);

		// Verify
		const result = await client.execute("SELECT * FROM test ORDER BY id");
		expect(result.rows.length).toBe(2);
		expect(result.rows[0].id).toBe("1");
		expect(result.rows[0].value).toBe("a");
		expect(result.rows[1].id).toBe("2");
		expect(result.rows[1].value).toBe("b");
	});

	it("should execute batch without mode (deferred)", async () => {
		await client.execute(
			"CREATE TABLE IF NOT EXISTS test2 (id TEXT, value TEXT)"
		);

		await client.batch([
			{ sql: "INSERT INTO test2 VALUES (?, ?)", args: ["x", "1"] },
			{ sql: "INSERT INTO test2 VALUES (?, ?)", args: ["y", "2"] },
		]);

		const result = await client.execute("SELECT * FROM test2 ORDER BY id");
		expect(result.rows.length).toBe(2);
	});

	it("should handle batch with read mode", async () => {
		await client.execute(
			"CREATE TABLE IF NOT EXISTS test3 (id TEXT PRIMARY KEY, value TEXT)"
		);
		await client.execute("INSERT INTO test3 VALUES ('a', '1')");
		await client.execute("INSERT INTO test3 VALUES ('b', '2')");

		const results = await client.batch(
			[
				{ sql: "SELECT * FROM test3 WHERE id = ?", args: ["a"] },
				{ sql: "SELECT * FROM test3 WHERE id = ?", args: ["b"] },
			],
			"read"
		);

		expect(results.length).toBe(2);
		expect(results[0].rows.length).toBe(1);
		expect(results[0].rows[0].value).toBe("1");
		expect(results[1].rows.length).toBe(1);
		expect(results[1].rows[0].value).toBe("2");
	});

	it("should handle empty batch", async () => {
		const results = await client.batch([]);
		expect(results.length).toBe(0);
	});

	it("should handle batch with single statement", async () => {
		await client.execute(
			"CREATE TABLE IF NOT EXISTS test4 (id TEXT, value TEXT)"
		);

		await client.batch([
			{ sql: "INSERT INTO test4 VALUES (?, ?)", args: ["single", "item"] },
		]);

		const result = await client.execute("SELECT * FROM test4");
		expect(result.rows.length).toBe(1);
	});
});

describe("Path-based Pipeline", () => {
	const dbName = `path-test-${Date.now()}`;

	beforeAll(async () => {
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: dbName, group: "mock" }),
		});
	});

	afterAll(async () => {
		await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${dbName}`,
			{ method: "DELETE" }
		);
	});

	it("should execute via path-based pipeline", async () => {
		const response = await fetch(
			`${MOCK_SERVER_URL}/${dbName}/v2/pipeline`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [
						{
							type: "execute",
							stmt: { sql: "SELECT 1 as value" },
						},
					],
				}),
			}
		);

		expect(response.ok).toBe(true);
		const data = await response.json();
		expect(data.results.length).toBe(1);
		expect(data.results[0].type).toBe("ok");
		expect(data.results[0].response.result.rows[0][0].value).toBe("1");
	});

	it("should handle store_sql and sql_id", async () => {
		const response = await fetch(
			`${MOCK_SERVER_URL}/${dbName}/v2/pipeline`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [
						{
							type: "store_sql",
							sql_id: 1,
							sql: "SELECT ? as value",
						},
						{
							type: "execute",
							stmt: {
								sql_id: 1,
								args: [{ type: "integer", value: "42" }],
							},
						},
					],
				}),
			}
		);

		expect(response.ok).toBe(true);
		const data = await response.json();
		expect(data.results.length).toBe(2);
		expect(data.results[0].response.type).toBe("store_sql");
		expect(data.results[1].response.result.rows[0][0].value).toBe("42");
	});

	it("should handle close request", async () => {
		const response = await fetch(
			`${MOCK_SERVER_URL}/${dbName}/v2/pipeline`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ type: "close" }],
				}),
			}
		);

		expect(response.ok).toBe(true);
		const data = await response.json();
		expect(data.results[0].response.type).toBe("close");
	});
});
