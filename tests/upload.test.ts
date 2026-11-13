import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createClient } from "@libsql/client";
import Database from "libsql";
import { createServer, MOCK_PLATFORM_TOKEN, MOCK_DB_JWT, MOCK_DB_JWT_READ_ONLY } from "../src/server";
import { setDbDir, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync, readFileSync } from "fs";

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
const TEST_PORT = 18087;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-upload");
const BUILD_DIR = join(import.meta.dir, ".test-build-upload");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	for (const d of [TEST_DB_DIR, BUILD_DIR]) {
		if (existsSync(d)) rmSync(d, { recursive: true });
		mkdirSync(d, { recursive: true });
	}
	setDbDir(TEST_DB_DIR);
	server = Bun.serve(createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR }));
});

afterAll(() => {
	closeAllDbs();
	server.stop();
	for (const d of [TEST_DB_DIR, BUILD_DIR]) if (existsSync(d)) rmSync(d, { recursive: true });
});

function vec(...xs: number[]) {
	return Buffer.from(new Float32Array(xs).buffer);
}

/** Build a small rag-like DB locally: FTS5 over bigram strings + per-kind partial vector indexes. */
function buildDb(path: string, wal: boolean) {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE chunks (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, embedding F32_BLOB(3));
		CREATE VIRTUAL TABLE chunks_fts USING fts5(bigrams, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
		CREATE INDEX vec_mail ON chunks(libsql_vector_idx(embedding)) WHERE kind = 'mail';
		CREATE INDEX vec_book ON chunks(libsql_vector_idx(embedding)) WHERE kind = 'book';
	`);
	const ins = db.prepare("INSERT INTO chunks (id, kind, text, embedding) VALUES (?, ?, ?, ?)");
	const fts = db.prepare("INSERT INTO chunks_fts (rowid, bigrams) VALUES (?, ?)");
	const rows: [number, string, string, string, Buffer][] = [
		[1, "mail", "消費税減税", "消費 費税 税減 減税", vec(1, 0, 0)],
		[2, "mail", "金融緩和", "金融 融緩 緩和", vec(0, 1, 0)],
		[3, "book", "消費税の歴史", "消費 費税 税の の歴 歴史", vec(0.9, 0.1, 0)],
		[4, "book", "Mehrwert des Kapitals", "mehrwert des kapitals", vec(0, 0, 1)],
	];
	for (const [id, kind, text, bigrams, e] of rows) {
		ins.run([id, kind, text, e]);
		fts.run([id, bigrams]);
	}
	if (wal) {
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}
	db.close();
}

async function createUploadDb(name: string) {
	return fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ name, group: "rag", seed: { type: "database_upload" } }),
	});
}

async function upload(name: string, bytes: Uint8Array, token = MOCK_DB_JWT) {
	return fetch(`${MOCK_SERVER_URL}/v1/upload`, {
		method: "POST",
		headers: { Host: `${name}.localhost:${TEST_PORT}`, Authorization: `Bearer ${token}` },
		body: bytes,
	});
}

describe("database upload", () => {
	it("uploads a WAL-mode file and serves FTS5 + partial vector search from it", async () => {
		const name = `up-${Date.now()}`;
		const file = join(BUILD_DIR, `${name}.db`);
		buildDb(file, true);

		expect((await createUploadDb(name)).status).toBe(200);
		const res = await upload(name, readFileSync(file));
		expect(res.status).toBe(200);

		const client = createClient({ url: `http://${name}.localhost:${TEST_PORT}` });

		const phrase = await client.execute({
			sql: "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)",
			args: ['"消費 費税"'],
		});
		expect(phrase.rows.map((r) => Number(r.rowid)).sort()).toEqual([1, 3]);

		const de = await client.execute({
			sql: "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?",
			args: ["kapitals"],
		});
		expect(de.rows.map((r) => Number(r.rowid))).toEqual([4]);

		// The partial index for mail must only return mail rows, even though a book row is closer.
		const mail = await client.execute({
			sql: "SELECT c.id FROM vector_top_k('vec_mail', vector32(?), 5) AS v JOIN chunks c ON c.rowid = v.id",
			args: ["[0.95, 0.05, 0]"],
		});
		expect(mail.rows.map((r) => Number(r.id))).toEqual([1, 2]);

		const book = await client.execute({
			sql: "SELECT c.id FROM vector_top_k('vec_book', vector32(?), 1) AS v JOIN chunks c ON c.rowid = v.id",
			args: ["[1, 0, 0]"],
		});
		expect(book.rows.map((r) => Number(r.id))).toEqual([3]);
		client.close();
	});

	it("rejects a non-WAL file", async () => {
		const name = `up-nowal-${Date.now()}`;
		const file = join(BUILD_DIR, `${name}.db`);
		buildDb(file, false);
		await createUploadDb(name);
		const res = await upload(name, readFileSync(file));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("WAL");
	});

	it("rejects upload to a database not created with seed database_upload", async () => {
		const name = `up-plain-${Date.now()}`;
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...AUTH },
			body: JSON.stringify({ name }),
		});
		const file = join(BUILD_DIR, `${name}.db`);
		buildDb(file, true);
		expect((await upload(name, readFileSync(file))).status).toBe(400);
	});

	it("accepts only one upload per seeded database", async () => {
		const name = `up-twice-${Date.now()}`;
		const file = join(BUILD_DIR, `${name}.db`);
		buildDb(file, true);
		await createUploadDb(name);
		expect((await upload(name, readFileSync(file))).status).toBe(200);
		expect((await upload(name, readFileSync(file))).status).toBe(400);
	});

	it("rejects an unknown seed type", async () => {
		const res = await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...AUTH },
			body: JSON.stringify({ name: `seed-x-${Date.now()}`, seed: { type: "dump" } }),
		});
		expect(res.status).toBe(400);
	});

	it("requires a bearer token", async () => {
		const res = await fetch(`${MOCK_SERVER_URL}/v1/upload`, {
			method: "POST",
			headers: { Host: `nope.localhost:${TEST_PORT}` },
			body: new Uint8Array(4),
		});
		expect(res.status).toBe(401);
	});
});

describe("group tokens", () => {
	it("mints full-access and read-only group tokens", async () => {
		const full = await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/groups/chat/auth/tokens`, {
			method: "POST",
			headers: AUTH,
		});
		expect(((await full.json()) as { jwt: string }).jwt).toBe(MOCK_DB_JWT);
		const ro = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/groups/rag/auth/tokens?authorization=read-only`,
			{ method: "POST", headers: AUTH },
		);
		expect(((await ro.json()) as { jwt: string }).jwt).toBe(MOCK_DB_JWT_READ_ONLY);
	});

	it("rejects writes sent with the read-only token but allows reads", async () => {
		const name = `ro-${Date.now()}`;
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...AUTH },
			body: JSON.stringify({ name }),
		});
		const rw = createClient({ url: `http://${name}.localhost:${TEST_PORT}`, authToken: MOCK_DB_JWT });
		await rw.execute("CREATE TABLE t (x INTEGER)");
		await rw.execute("INSERT INTO t VALUES (1)");
		const ro = createClient({
			url: `http://${name}.localhost:${TEST_PORT}`,
			authToken: MOCK_DB_JWT_READ_ONLY,
		});
		expect((await ro.execute("SELECT x FROM t")).rows.length).toBe(1);
		await expect(ro.execute("INSERT INTO t VALUES (2)")).rejects.toThrow();
		rw.close();
		ro.close();
	});
});
