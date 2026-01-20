#!/usr/bin/env bun
import { createServer } from "./server";
import { setDbDir, getDbDir, resetAllDbs, ensureDbDir, listDatabases } from "./db";
import { resolve } from "path";
import { createInterface } from "readline";

const VERSION = "1.0.0";

function printHelp() {
	console.log(`
tursomock v${VERSION} - Turso Mock Server

Usage:
  tursomock <command> [options]

Commands:
  serve       Start the mock server
  reset       Reset (delete) all databases

Options:
  --help, -h  Show this help message
  --version   Show version number

Examples:
  tursomock serve --port 8080 --db-dir ./db
  tursomock reset --force
  tursomock --help
`);
}

function printServeHelp() {
	console.log(`
tursomock serve - Start the mock server

Usage:
  tursomock serve [options]

Options:
  --port <number>     Port to listen on (default: 8080)
  --db-dir <path>     Database directory (default: ./db)
  --help, -h          Show this help message

Examples:
  tursomock serve
  tursomock serve --port 3000
  tursomock serve --db-dir ./test-db --port 8080
`);
}

function printResetHelp() {
	console.log(`
tursomock reset - Reset (delete) all databases

Usage:
  tursomock reset [options]

Options:
  --db-dir <path>     Database directory (default: ./db)
  --force, -f         Skip confirmation prompt
  --help, -h          Show this help message

Examples:
  tursomock reset
  tursomock reset --force
  tursomock reset --db-dir ./test-db --force
`);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
	const result: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version") {
			result.version = true;
		} else if (arg === "--force" || arg === "-f") {
			result.force = true;
		} else if (arg === "--port") {
			result.port = args[++i];
		} else if (arg === "--db-dir") {
			result.dbDir = args[++i];
		} else if (!arg.startsWith("-")) {
			result.command = arg;
		}
	}
	return result;
}

async function confirm(message: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`${message} (y/N): `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

async function serveCommand(args: Record<string, string | boolean>) {
	if (args.help) {
		printServeHelp();
		return;
	}

	const port = args.port ? parseInt(args.port as string, 10) : 8080;
	const dbDir = args.dbDir ? resolve(args.dbDir as string) : resolve("./db");

	setDbDir(dbDir);
	ensureDbDir();

	const server = createServer({ port, dbDir });

	console.log(`Turso Mock Server running on http://localhost:${port}`);
	console.log(`DB directory: ${dbDir}`);
	console.log(`Use subdomain format: http://<dbname>.localhost:${port}`);

	Bun.serve(server);
}

async function resetCommand(args: Record<string, string | boolean>) {
	if (args.help) {
		printResetHelp();
		return;
	}

	const dbDir = args.dbDir ? resolve(args.dbDir as string) : resolve("./db");
	setDbDir(dbDir);

	const databases = listDatabases();
	if (databases.length === 0) {
		console.log(`No databases found in ${dbDir}`);
		return;
	}

	console.log(`Found ${databases.length} database(s) in ${dbDir}:`);
	for (const db of databases) {
		console.log(`  - ${db}`);
	}

	if (!args.force) {
		const confirmed = await confirm("\nAre you sure you want to delete all databases?");
		if (!confirmed) {
			console.log("Aborted.");
			return;
		}
	}

	resetAllDbs();
	console.log(`\nAll databases have been deleted.`);
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));

	if (args.version) {
		console.log(`tursomock v${VERSION}`);
		return;
	}

	if (args.help && !args.command) {
		printHelp();
		return;
	}

	const command = args.command as string;

	switch (command) {
		case "serve":
			await serveCommand(args);
			break;
		case "reset":
			await resetCommand(args);
			break;
		default:
			if (command) {
				console.error(`Unknown command: ${command}`);
			}
			printHelp();
			process.exit(command ? 1 : 0);
	}
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
