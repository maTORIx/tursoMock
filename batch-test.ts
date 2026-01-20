import { createClient } from "@libsql/client";

const client = createClient({
    url: "http://testdb.localhost:8080",
});

async function test() {
    try {
        // Create table first
        await client.execute("CREATE TABLE IF NOT EXISTS test (id TEXT, value TEXT)");
        console.log("Table created");

        // Test batch with write mode
        await client.batch([
            { sql: "INSERT INTO test VALUES (?, ?)", args: ["1", "a"] },
            { sql: "INSERT INTO test VALUES (?, ?)", args: ["2", "b"] },
        ], "write");
        console.log("Batch insert success");

        // Verify
        const result = await client.execute("SELECT * FROM test");
        console.log("Results:", result.rows);
    } catch (e) {
        console.error("Error:", e);
    }
}

test();
