import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, MOCK_PLATFORM_TOKEN } from "../src/server";
import { setDbDir, setInMemory, closeAllDbs, listDatabases, resetAllDbs } from "../src/db";
import { join } from "path";
import { existsSync, rmSync } from "fs";

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
const TEST_PORT = 18087;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-ns");
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

function createDb(prefix: string, name: string) {
	return fetch(`${BASE}${prefix}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ name }),
	});
}

async function listDbNames(prefix: string): Promise<string[]> {
	const res = await fetch(`${BASE}${prefix}/v1/organizations/mock/databases`, {
		headers: AUTH,
	});
	const data = (await res.json()) as { databases: { Name: string }[] };
	return data.databases.map((d) => d.Name).sort();
}

async function execute(prefix: string, name: string, sql: string) {
	const res = await fetch(`${BASE}${prefix}/${name}/v2/pipeline`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			requests: [{ type: "execute", stmt: { sql } }],
		}),
	});
	return { status: res.status, body: (await res.json()) as any };
}

async function seedAndRead(prefix: string, value: number): Promise<string> {
	await execute(prefix, "same-name", "CREATE TABLE t (v INTEGER)");
	await execute(prefix, "same-name", `INSERT INTO t VALUES (${value})`);
	const { body } = await execute(prefix, "same-name", "SELECT v FROM t");
	return body.results[0].response.result.rows[0][0].value;
}

function defineSuite(label: string, inMemory: boolean) {
	describe(label, () => {
		beforeAll(() => {
			if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
			setDbDir(TEST_DB_DIR);
			setInMemory(inMemory);
			server = Bun.serve(createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR }));
		});

		afterAll(() => {
			closeAllDbs();
			server.stop(true);
			setInMemory(false);
			if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
		});

		it("gives each namespace its own database under the same name", async () => {
			expect((await createDb("/ns/ns-a", "same-name")).status).toBe(200);
			expect((await createDb("/ns/ns-b", "same-name")).status).toBe(200);
			expect((await createDb("", "same-name")).status).toBe(200);

			expect(await seedAndRead("/ns/ns-a", 1)).toBe("1");
			expect(await seedAndRead("/ns/ns-b", 2)).toBe("2");
			expect(await seedAndRead("", 3)).toBe("3");
		});

		it("rejects a duplicate only within the same namespace", async () => {
			expect((await createDb("/ns/ns-a", "same-name")).status).toBe(409);
			expect((await createDb("/ns/ns-c", "same-name")).status).toBe(200);
		});

		it("lists only the databases of the requested namespace", async () => {
			await createDb("/ns/ns-d", "only-in-d");

			expect(await listDbNames("/ns/ns-d")).toEqual(["only-in-d"]);
			expect(await listDbNames("/ns/empty")).toEqual([]);
			expect(await listDbNames("")).toEqual(["same-name"]);
		});

		it("deletes only the namespace's database", async () => {
			const res = await fetch(
				`${BASE}/ns/ns-a/v1/organizations/mock/databases/same-name`,
				{ method: "DELETE", headers: AUTH }
			);

			expect(res.status).toBe(200);
			expect(await listDbNames("/ns/ns-a")).toEqual([]);
			expect(await listDbNames("/ns/ns-b")).toEqual(["same-name"]);
		});

		it("does not serve a database from another namespace", async () => {
			await createDb("/ns/ns-e", "private");

			const { status } = await execute("/ns/ns-f", "private", "SELECT 1");

			expect(status).toBe(404);
		});

		it("requires the platform token inside a namespace", async () => {
			const res = await fetch(`${BASE}/ns/ns-a/v1/organizations/mock/databases`);

			expect(res.status).toBe(401);
		});

		it("rejects a malformed namespace", async () => {
			expect((await createDb("/ns/Upper_Case", "db")).status).toBe(400);
		});

		it("removes namespaced databases on reset", async () => {
			await createDb("/ns/ns-reset", "db");

			resetAllDbs();

			expect(listDatabases("ns-reset")).toEqual([]);
		});
	});
}

defineSuite("namespaces on disk", false);
defineSuite("namespaces in memory", true);

describe("in-memory storage", () => {
	it("writes nothing to the database directory", async () => {
		rmSync(TEST_DB_DIR, { recursive: true, force: true });
		setDbDir(TEST_DB_DIR);
		setInMemory(true);
		server = Bun.serve(createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR }));
		try {
			await createDb("", "memory-only");
			await execute("", "memory-only", "CREATE TABLE t (v INTEGER)");

			expect(existsSync(TEST_DB_DIR)).toBe(false);
		} finally {
			closeAllDbs();
			server.stop(true);
			setInMemory(false);
		}
	});
});
