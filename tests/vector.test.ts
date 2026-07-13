import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createClient } from "@libsql/client";
import { createServer, MOCK_PLATFORM_TOKEN } from "../src/server";
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
const TEST_PORT = 18085;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-vector");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

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

// Verifies the engine swap (bun:sqlite -> libsql) actually exposes libSQL's
// native vector search. These functions/types do NOT exist in stock SQLite.
describe("libSQL native vector search", () => {
	const dbName = `vector-test-${Date.now()}`;
	let client: ReturnType<typeof createClient>;

	beforeAll(async () => {
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...AUTH },
			body: JSON.stringify({ name: dbName, group: "mock" }),
		});
		client = createClient({ url: `http://${dbName}.localhost:${TEST_PORT}` });
	});

	afterAll(async () => {
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${dbName}`, {
			method: "DELETE",
			headers: AUTH,
		});
	});

	it("supports F32_BLOB, vector32, vector_distance_cos, libsql_vector_idx and vector_top_k", async () => {
		await client.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, emb F32_BLOB(3))");
		await client.execute("INSERT INTO items (id, emb) VALUES (1, vector32('[1.0, 0.0, 0.0]'))");
		await client.execute("INSERT INTO items (id, emb) VALUES (2, vector32('[0.0, 1.0, 0.0]'))");
		await client.execute("INSERT INTO items (id, emb) VALUES (3, vector32('[0.9, 0.1, 0.0]'))");

		// Brute-force cosine ordering: closest to [1,0,0] is id=1, then id=3.
		const dist = await client.execute(
			"SELECT id, vector_distance_cos(emb, vector32('[1.0, 0.0, 0.0]')) AS d FROM items ORDER BY d ASC",
		);
		const orderedIds = dist.rows.map((r) => Number(r.id));
		expect(orderedIds[0]).toBe(1);
		expect(orderedIds[1]).toBe(3);

		// Native ANN index + vector_top_k. Alias the table function output so
		// `id` isn't ambiguous against items.id (the query shape kannon must use,
		// since detected_posts also has an `id` column).
		await client.execute("CREATE INDEX items_idx ON items(libsql_vector_idx(emb))");
		const top = await client.execute({
			sql: "SELECT items.id AS id FROM vector_top_k('items_idx', vector32('[1.0, 0.0, 0.0]'), 2) AS vtk JOIN items ON items.rowid = vtk.id",
			args: [],
		});
		const topIds = top.rows.map((r) => Number(r.id)).sort();
		expect(topIds).toContain(1);
		expect(top.rows.length).toBe(2);
	});

	// Raw F32 little-endian blob params (what timeloom sends instead of
	// vector32('[...]') text). Regression: libsql's JS wrapper treats a lone
	// object bind param as a *named*-params object, so a single Buffer arg
	// panicked the native side until the server passed positional args as one
	// array. Also covers Hrana JSON blob encoding ({type:"blob", base64}) both
	// directions and ArrayBuffer results from BLOB columns.
	it("binds raw F32 blob params for insert / distance / top_k and returns blobs", async () => {
		const vec = (arr: number[]) => new Uint8Array(new Float32Array(arr).buffer);
		await client.execute("CREATE TABLE blobs (id INTEGER PRIMARY KEY, emb F32_BLOB(3))");
		await client.execute("CREATE INDEX blobs_idx ON blobs(libsql_vector_idx(emb))");
		await client.execute({ sql: "INSERT INTO blobs (id, emb) VALUES (?, ?)", args: [1, vec([1, 0, 0])] });
		await client.execute({ sql: "INSERT INTO blobs (id, emb) VALUES (?, ?)", args: [2, vec([0, 1, 0])] });
		await client.execute({ sql: "INSERT INTO blobs (id, emb) VALUES (?, ?)", args: [3, vec([0.9, 0.1, 0])] });

		const dist = await client.execute({
			sql: "SELECT id, vector_distance_cos(emb, ?) AS d FROM blobs ORDER BY d ASC",
			args: [vec([1, 0, 0])],
		});
		expect(dist.rows.map((r) => Number(r.id))).toEqual([1, 3, 2]);

		const top = await client.execute({
			sql: "SELECT blobs.id AS id FROM vector_top_k('blobs_idx', ?, 2) AS vtk JOIN blobs ON blobs.rowid = vtk.id",
			args: [vec([1, 0, 0])],
		});
		expect(top.rows.length).toBe(2);
		expect(top.rows.map((r) => Number(r.id))).toContain(1);

		// blob column comes back as a binary value that round-trips to the same floats
		const back = await client.execute({ sql: "SELECT emb FROM blobs WHERE id = 1", args: [] });
		const raw = back.rows[0].emb as ArrayBuffer | Uint8Array;
		const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
		expect(bytes.byteLength).toBe(12);
		const f32 = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		expect(Array.from(f32)).toEqual([1, 0, 0]);
	});

	// INSERT ... RETURNING returns rows; libsql requires .all() (not .run()).
	// kannon uses RETURNING against Turso (src/routes/targets/search.tsx), so the
	// mock must handle it via the `.reader` branch.
	it("handles INSERT ... RETURNING", async () => {
		await client.execute("CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT)");
		const res = await client.execute({
			sql: "INSERT INTO r (v) VALUES (?) RETURNING id, v",
			args: ["hello"],
		});
		expect(res.rows.length).toBe(1);
		expect(res.rows[0].v).toBe("hello");
	});
});
