import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, MOCK_PLATFORM_TOKEN } from "../src/server";
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_PORT = 18084;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-auth");
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

describe("Management API - Platform token auth", () => {
	it("exposes a fixed mock token", () => {
		expect(typeof MOCK_PLATFORM_TOKEN).toBe("string");
		expect(MOCK_PLATFORM_TOKEN.length).toBeGreaterThan(0);
	});

	it("POST create without Authorization -> 401", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "auth-no-header", group: "default" }),
			}
		);
		expect(resp.status).toBe(401);
	});

	it("POST create with wrong token -> 401", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer wrong-token",
				},
				body: JSON.stringify({ name: "auth-bad", group: "default" }),
			}
		);
		expect(resp.status).toBe(401);
	});

	it("POST create with correct token -> 200", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}`,
				},
				body: JSON.stringify({ name: "auth-ok", group: "default" }),
			}
		);
		expect(resp.ok).toBe(true);
	});

	it("GET list without Authorization -> 401", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`
		);
		expect(resp.status).toBe(401);
	});

	it("GET list with Authorization -> 200", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{ headers: { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` } }
		);
		expect(resp.ok).toBe(true);
	});

	it("DELETE without Authorization -> 401", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/auth-ok`,
			{ method: "DELETE" }
		);
		expect(resp.status).toBe(401);
	});

	it("non-Bearer scheme -> 401", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{ headers: { Authorization: `Basic ${MOCK_PLATFORM_TOKEN}` } }
		);
		expect(resp.status).toBe(401);
	});

	it("health endpoint does NOT require auth", async () => {
		const resp = await fetch(`${MOCK_SERVER_URL}/health`);
		expect(resp.ok).toBe(true);
	});

	it("Hrana pipeline does NOT require auth (mock convenience)", async () => {
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}`,
			},
			body: JSON.stringify({ name: "pipeline-noauth", group: "default" }),
		});
		const resp = await fetch(
			`${MOCK_SERVER_URL}/pipeline-noauth/v2/pipeline`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ type: "execute", stmt: { sql: "SELECT 1" } }],
				}),
			}
		);
		expect(resp.ok).toBe(true);
	});
});

describe("Management API - Database auth token creation", () => {
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}`,
	};
	const dbName = `tok-db-${Date.now()}`;

	beforeAll(async () => {
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: dbName, group: "default" }),
		});
	});

	it("POST /auth/tokens returns a jwt", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${dbName}/auth/tokens`,
			{ method: "POST", headers }
		);
		expect(resp.ok).toBe(true);
		const data = (await resp.json()) as { jwt: string };
		expect(typeof data.jwt).toBe("string");
		expect(data.jwt.length).toBeGreaterThan(0);
	});

	it("POST /auth/tokens without auth -> 401", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${dbName}/auth/tokens`,
			{ method: "POST" }
		);
		expect(resp.status).toBe(401);
	});

	it("POST /auth/tokens for unknown database -> 404", async () => {
		const resp = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/nope-xyz/auth/tokens`,
			{ method: "POST", headers }
		);
		expect(resp.status).toBe(404);
	});
});
