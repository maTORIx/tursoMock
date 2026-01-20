import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createClient } from "@libsql/client";
import { createServer } from "../src/server";
import { setDbDir, resetAllDbs, closeAllDbs } from "../src/db";
import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_PORT = 18080;
const TEST_DB_DIR = join(import.meta.dir, ".test-db");
const MOCK_SERVER_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve>;

interface Post {
	id: string;
	targetId: string;
	source: "x" | "instagram" | "facebook" | "internet";
	sourceId: string;
	text: string;
	data: object;
	createdAt: Date;
	evidenceImageIds: string[];
}

function createTestPost(overrides: Partial<Post> = {}): Post {
	const id = `post-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return {
		id,
		targetId: "target-1",
		source: "x",
		sourceId: `tweet-${id}`,
		text: "This is a test post content",
		data: {
			source: "x",
			id: `tweet-${id}`,
			authorId: "testuser",
			url: `https://x.com/testuser/status/${id}`,
		},
		createdAt: new Date(),
		evidenceImageIds: [],
		...overrides,
	};
}

async function createMockDb(dbName: string) {
	const resp = await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: dbName, group: "mock" }),
	});
	return resp.ok || resp.status === 409;
}

async function deleteMockDb(dbName: string) {
	await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${dbName}`, {
		method: "DELETE",
	});
}

function getClient(dbName: string) {
	return createClient({
		url: `http://${dbName}.localhost:${TEST_PORT}`,
	});
}

const SCHEMA = `
CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    targetId TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('x', 'instagram', 'facebook', 'internet')),
    sourceId TEXT NOT NULL,
    text TEXT NOT NULL,
    data TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    evidenceImageIds TEXT NOT NULL
);

CREATE INDEX posts_targetId_createdAt_index ON posts (targetId, createdAt);
CREATE INDEX posts_createdAt_index ON posts (createdAt);
CREATE INDEX posts_source_sourceId_index ON posts (source, sourceId);

CREATE VIRTUAL TABLE posts_fts USING fts5(content, content_id UNINDEXED);
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts (content, content_id) VALUES (new.text, new.id);
END;
`;

async function insertPost(client: ReturnType<typeof createClient>, post: Post) {
	await client.execute({
		sql: `INSERT INTO posts (id, targetId, source, sourceId, text, data, createdAt, evidenceImageIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			post.id,
			post.targetId,
			post.source,
			post.sourceId,
			post.text,
			JSON.stringify(post.data),
			post.createdAt.getTime(),
			JSON.stringify(post.evidenceImageIds),
		],
	});
}

async function getPost(client: ReturnType<typeof createClient>, postId: string) {
	const res = await client.execute({
		sql: `SELECT * FROM posts WHERE id = ?`,
		args: [postId],
	});
	if (res.rows.length === 0) return null;
	const row = res.rows[0];
	return {
		id: row.id as string,
		targetId: row.targetId as string,
		source: row.source as string,
		sourceId: row.sourceId as string,
		text: row.text as string,
		data: JSON.parse(row.data as string),
		createdAt: new Date(Number(row.createdAt)),
		evidenceImageIds: JSON.parse(row.evidenceImageIds as string),
	};
}

// Setup and teardown for all tests
beforeAll(() => {
	// Clean up and create test db directory
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

describe("Server - Posts Mock", () => {
	const testUserId = `test-mock-${Date.now()}`;
	const dbName = `user_${testUserId}`;
	let client: ReturnType<typeof createClient>;

	beforeAll(async () => {
		await createMockDb(dbName);
		client = getClient(dbName);
		await client.execute(SCHEMA);
	});

	afterAll(async () => {
		await deleteMockDb(dbName);
	});

	it("should create user database and table", async () => {
		const result = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='posts'"
		);
		expect(result.rows.length).toBe(1);
		expect(result.rows[0].name).toBe("posts");
	});

	it("should insert and retrieve a post", async () => {
		const post = createTestPost();
		await insertPost(client, post);

		const retrieved = await getPost(client, post.id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.id).toBe(post.id);
		expect(retrieved!.text).toBe(post.text);
		expect(retrieved!.source).toBe("x");
	});

	it("should insert posts in batch", async () => {
		const posts = [
			createTestPost({ text: "Batch post 1" }),
			createTestPost({ text: "Batch post 2" }),
			createTestPost({ text: "Batch post 3" }),
		];

		for (const post of posts) {
			await insertPost(client, post);
		}

		for (const post of posts) {
			const retrieved = await getPost(client, post.id);
			expect(retrieved).not.toBeNull();
			expect(retrieved!.id).toBe(post.id);
		}
	});

	it("should get recent posts with pagination", async () => {
		const posts = [];
		for (let i = 0; i < 5; i++) {
			const post = createTestPost({
				text: `Pagination test ${i}`,
				createdAt: new Date(Date.now() + i * 1000),
			});
			posts.push(post);
		}
		for (const post of posts) {
			await insertPost(client, post);
		}

		const result = await client.execute({
			sql: `SELECT * FROM posts ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
			args: [3, 0],
		});

		expect(result.rows.length).toBe(3);
	});

	it("should search posts using FTS", async () => {
		const uniqueKeyword = `uniquekeyword${Date.now()}`;
		const post = createTestPost({
			text: `This post contains ${uniqueKeyword} for testing`,
		});
		await insertPost(client, post);

		const result = await client.execute({
			sql: `SELECT p.* FROM posts p JOIN posts_fts fts ON p.id = fts.content_id WHERE fts.content MATCH ?`,
			args: [uniqueKeyword + "*"],
		});

		expect(result.rows.length).toBeGreaterThan(0);
	});

	it("should handle different post sources", async () => {
		const instagramPost = createTestPost({
			source: "instagram",
			sourceId: "ig-123",
			data: {
				source: "instagram",
				id: "ig-123",
				authorId: "iguser",
			},
		});

		await insertPost(client, instagramPost);

		const retrieved = await getPost(client, instagramPost.id);
		expect(retrieved!.source).toBe("instagram");
	});

	it("should return null for non-existent post", async () => {
		const result = await getPost(client, "non-existent-id");
		expect(result).toBeNull();
	});

	it("should isolate data between different users", async () => {
		const anotherUserId = `test-mock-another-${Date.now()}`;
		const anotherDbName = `user_${anotherUserId}`;

		await createMockDb(anotherDbName);
		const anotherClient = getClient(anotherDbName);
		await anotherClient.execute(SCHEMA);

		// Insert post for first user
		const post1 = createTestPost({ text: "User 1 post" });
		await insertPost(client, post1);

		// Insert post for second user
		const post2 = createTestPost({ text: "User 2 post" });
		await insertPost(anotherClient, post2);

		// First user should not see second user's post
		const user1Result = await getPost(client, post2.id);
		expect(user1Result).toBeNull();

		// Second user should not see first user's post
		const user2Result = await getPost(anotherClient, post1.id);
		expect(user2Result).toBeNull();

		await deleteMockDb(anotherDbName);
	});
});

describe("Server - Health Check", () => {
	it("should return health status", async () => {
		const response = await fetch(`${MOCK_SERVER_URL}/health`);
		const data = await response.json();
		expect(data.status).toBe("ok");
		expect(typeof data.databases).toBe("number");
	});
});

describe("Server - Management API", () => {
	it("should list databases", async () => {
		const response = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`
		);
		const data = await response.json();
		expect(Array.isArray(data.databases)).toBe(true);
	});

	it("should create and delete database", async () => {
		const testDbName = `test-create-delete-${Date.now()}`;

		// Create
		const createResponse = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: testDbName, group: "mock" }),
			}
		);
		expect(createResponse.ok).toBe(true);
		const createData = await createResponse.json();
		expect(createData.database.Name).toBe(testDbName);

		// Delete
		const deleteResponse = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${testDbName}`,
			{ method: "DELETE" }
		);
		expect(deleteResponse.ok).toBe(true);
	});

	it("should return 409 for duplicate database", async () => {
		const testDbName = `test-duplicate-${Date.now()}`;

		// Create first time
		await fetch(`${MOCK_SERVER_URL}/v1/organizations/mock/databases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: testDbName, group: "mock" }),
		});

		// Create second time - should fail
		const response = await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: testDbName, group: "mock" }),
			}
		);
		expect(response.status).toBe(409);

		// Cleanup
		await fetch(
			`${MOCK_SERVER_URL}/v1/organizations/mock/databases/${testDbName}`,
			{ method: "DELETE" }
		);
	});
});
