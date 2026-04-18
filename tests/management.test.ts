import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, MOCK_PLATFORM_TOKEN } from "../src/server";

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_PORT = 18083;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-mgmt");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	setDbDir(TEST_DB_DIR);

	const serverConfig = createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR });
	server = Bun.serve(serverConfig);
});

afterAll(() => {
	closeAllDbs();
	server.stop();
	if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
});

async function createDb(name: string, group = "default") {
	return fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ name, group }),
	});
}

describe("Management API - Create database response", () => {
	it("uses Hostname (not HostName) and includes required fields", async () => {
		const name = `create-${Date.now()}`;
		const resp = await createDb(name, "default");
		const data = (await resp.json()) as { database: Record<string, unknown> };
		const db = data.database;

		expect(db.Name).toBe(name);
		expect(typeof db.DbId).toBe("string");
		expect(typeof db.Hostname).toBe("string");
		// The wrong/legacy key must not be used
		expect(db.HostName).toBeUndefined();
	});

	it("returns 400 for invalid name", async () => {
		const resp = await createDb("INVALID NAME!", "default");
		expect(resp.status).toBe(400);
	});
});

describe("Management API - List databases", () => {
	it("returns databases with full field set", async () => {
		const name = `list-${Date.now()}`;
		await createDb(name, "default");

		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{ headers: AUTH }
		);
		const data = (await resp.json()) as {
			databases: Record<string, unknown>[];
		};
		expect(Array.isArray(data.databases)).toBe(true);
		const db = data.databases.find((d) => d.Name === name);
		expect(db).toBeDefined();
		expect(typeof db!.Hostname).toBe("string");
		expect(typeof db!.block_reads).toBe("boolean");
		expect(typeof db!.block_writes).toBe("boolean");
		expect(typeof db!.primaryRegion).toBe("string");
		expect(typeof db!.group).toBe("string");
		expect(typeof db!.delete_protection).toBe("boolean");
		expect(Array.isArray(db!.regions)).toBe(true);
	});
});

describe("Management API - Retrieve single database", () => {
	it("GET /v1/organizations/:org/databases/:name returns the database", async () => {
		const name = `retrieve-${Date.now()}`;
		await createDb(name, "default");

		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${name}`,
			{ headers: AUTH }
		);
		expect(resp.ok).toBe(true);
		const data = (await resp.json()) as { database: Record<string, unknown> };
		expect(data.database.Name).toBe(name);
		expect(typeof data.database.Hostname).toBe("string");
		expect(typeof data.database.group).toBe("string");
	});

	it("returns 404 for unknown database", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/does-not-exist-xyz`,
			{ headers: AUTH }
		);
		expect(resp.status).toBe(404);
		const data = (await resp.json()) as { error: string };
		expect(typeof data.error).toBe("string");
	});
});
