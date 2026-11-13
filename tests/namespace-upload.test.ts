import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import Database from "libsql";
import { createServer, MOCK_PLATFORM_TOKEN, MOCK_DB_JWT, MOCK_DB_JWT_READ_ONLY } from "../src/server";
import { setDbDir, setInMemory, closeAllDbs, resetAllDbs } from "../src/db";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";

/**
 * 名前空間 (/ns/<ns>) とインメモリ (--memory) の上での、upload と read-only トークン。
 * ファイルのモードではどちらも名前空間ごとに分かれる。インメモリでは両方とも受けない:
 * インメモリの DB は読み取り専用の接続を別に開けず (shared cache では readonly の指定が効かない)、
 * ファイルからの差し替えもできないので、守れているふりをせず 400 で断る。
 */

const AUTH = { Authorization: `Bearer ${MOCK_PLATFORM_TOKEN}` };
const TEST_PORT = 18091;
const TEST_DB_DIR = join(import.meta.dir, ".test-db-ns-upload");
const BUILD_DIR = join(import.meta.dir, ".test-build-ns-upload");
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

type Result = { type: "ok"; response: any } | { type: "error"; error: { message: string } };

function createDb(prefix: string, name: string, seed?: { type: string }) {
	return fetch(`${BASE}${prefix}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ name, ...(seed ? { seed } : {}) }),
	});
}

function upload(prefix: string, name: string, bytes: Uint8Array) {
	return fetch(`${BASE}${prefix}/v1/upload`, {
		method: "POST",
		headers: { Host: `${name}.localhost:${TEST_PORT}`, Authorization: `Bearer ${MOCK_DB_JWT}` },
		body: bytes,
	});
}

async function execute(prefix: string, name: string, sql: string, token = MOCK_DB_JWT): Promise<Result> {
	const res = await fetch(`${BASE}${prefix}/${name}/v2/pipeline`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql } }] }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { results: Result[] }).results[0];
}

const rowsOf = (r: Result) => {
	if (r.type !== "ok") throw new Error(r.error.message);
	return r.response.result.rows.map((row: { value: string }[]) => row.map((v) => v.value));
};

/** WAL モードの小さな DB ファイル (中身は v の 1 行) */
function buildDb(value: number): Uint8Array {
	const path = join(BUILD_DIR, `build-${value}.db`);
	if (existsSync(path)) rmSync(path);
	const db = new Database(path);
	db.exec(`CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (${value}); PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);`);
	db.close();
	return new Uint8Array(readFileSync(path));
}

function start(inMemory: boolean) {
	for (const d of [TEST_DB_DIR, BUILD_DIR]) {
		if (existsSync(d)) rmSync(d, { recursive: true });
		mkdirSync(d, { recursive: true });
	}
	setDbDir(TEST_DB_DIR);
	setInMemory(inMemory);
	server = Bun.serve(createServer({ port: TEST_PORT, dbDir: TEST_DB_DIR }));
}

function stop() {
	closeAllDbs();
	server.stop(true);
	setInMemory(false);
	for (const d of [TEST_DB_DIR, BUILD_DIR]) if (existsSync(d)) rmSync(d, { recursive: true });
}

describe("ファイルのモード: 名前空間ごとの upload と read-only", () => {
	beforeAll(() => start(false));
	afterAll(stop);

	it("名前空間の中の upload はその名前空間の DB だけを置き換える (同じ名前の他の DB は触らない)", async () => {
		expect((await createDb("/ns/ns-a", "up", { type: "database_upload" })).status).toBe(200);
		expect((await createDb("", "up", { type: "database_upload" })).status).toBe(200);

		const res = await upload("/ns/ns-a", "up", buildDb(7));
		expect(res.status).toBe(200);

		expect(rowsOf(await execute("/ns/ns-a", "up", "SELECT v FROM t"))).toEqual([["7"]]);
		// 名前空間の外の同じ名前の DB は空のまま
		const outside = await execute("", "up", "SELECT v FROM t");
		expect(outside.type).toBe("error");
		// 外のほうはまだ upload を受ける (印は名前空間ごと)
		expect((await upload("", "up", buildDb(8))).status).toBe(200);
		expect(rowsOf(await execute("", "up", "SELECT v FROM t"))).toEqual([["8"]]);
	});

	it("名前空間の中で upload 用でない DB への upload は 400 (名前空間の外の印を見ない)", async () => {
		expect((await createDb("", "plain-ns", { type: "database_upload" })).status).toBe(200);
		expect((await createDb("/ns/ns-b", "plain-ns")).status).toBe(200);
		const res = await upload("/ns/ns-b", "plain-ns", buildDb(1));
		expect(res.status).toBe(400);
	});

	it("名前空間に無い DB への upload は 404", async () => {
		expect((await upload("/ns/ns-c", "nothing-here", buildDb(1))).status).toBe(404);
	});

	it("名前空間の中でも read-only トークンの書き込みは SQLite が断り、書けるトークンなら通る", async () => {
		expect((await createDb("/ns/ns-r", "ro")).status).toBe(200);
		rowsOf(await execute("/ns/ns-r", "ro", "CREATE TABLE t (v INTEGER)"));
		const denied = await execute("/ns/ns-r", "ro", "INSERT INTO t VALUES (1)", MOCK_DB_JWT_READ_ONLY);
		expect(denied.type).toBe("error");
		expect(rowsOf(await execute("/ns/ns-r", "ro", "SELECT count(*) FROM t", MOCK_DB_JWT_READ_ONLY))).toEqual([["0"]]);
		rowsOf(await execute("/ns/ns-r", "ro", "INSERT INTO t VALUES (1)"));
		expect(rowsOf(await execute("/ns/ns-r", "ro", "SELECT count(*) FROM t", MOCK_DB_JWT_READ_ONLY))).toEqual([["1"]]);
	});

	it("resetAllDbs は upload 待ちの印も消す (根と名前空間の両方)", async () => {
		expect((await createDb("", "mark-root", { type: "database_upload" })).status).toBe(200);
		expect((await createDb("/ns/ns-m", "mark-ns", { type: "database_upload" })).status).toBe(200);
		resetAllDbs();
		const left = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
		expect(left(TEST_DB_DIR).filter((f) => f.endsWith(".awaiting-upload"))).toEqual([]);
		expect(existsSync(join(TEST_DB_DIR, "ns-m"))).toBe(false);
	});
});

describe("インメモリ: upload と read-only トークンは受けない (本物どおりに守れないので、はっきり断る)", () => {
	beforeAll(() => start(true));
	afterAll(stop);

	it("seed: database_upload の DB は作る時点で 400 にし、DB を作らない", async () => {
		const res = await createDb("", "mem-up", { type: "database_upload" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("--memory");
		// 作っていないので、同じ名前で普通に作れる
		expect((await createDb("", "mem-up")).status).toBe(200);
	});

	it("read-only トークンの pipeline は 400 で、何も流さない。書けるトークンは通る", async () => {
		expect((await createDb("/ns/ns-mem", "ro")).status).toBe(200);
		rowsOf(await execute("/ns/ns-mem", "ro", "CREATE TABLE t (v INTEGER)"));
		const res = await fetch(`${BASE}/ns/ns-mem/ro/v2/pipeline`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_DB_JWT_READ_ONLY}` },
			body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "INSERT INTO t VALUES (1)" } }] }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("--memory");
		expect(rowsOf(await execute("/ns/ns-mem", "ro", "SELECT count(*) FROM t"))).toEqual([["0"]]);
	});
});
