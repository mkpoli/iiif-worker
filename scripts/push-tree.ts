/**
 * Push a local ingest tree through the Worker's token-gated /ingest route.
 *
 *   INGEST_TOKEN=... bun run scripts/push-tree.ts /tmp/tree https://iiif.example.org [--jobs 16] [--verify]
 *
 * --verify skips objects whose info.json already answers 200 (prefix-level
 * check), so re-runs only fill gaps.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const [root, base] = process.argv.slice(2);
const jobsFlag = process.argv.indexOf("--jobs");
const jobs = jobsFlag >= 0 ? Number(process.argv[jobsFlag + 1] ?? 16) : 16;
const verify = process.argv.includes("--verify");
const token = process.env.INGEST_TOKEN;
if (!root || !base || !token) {
	console.error(
		"usage: INGEST_TOKEN=... bun run scripts/push-tree.ts <tree> <base> [--jobs n] [--verify]",
	);
	process.exit(1);
}

async function* walk(dir: string): AsyncGenerator<string> {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

const files: string[] = [];
for await (const f of walk(root)) files.push(f);
files.sort();
console.log(`${files.length} objects`);

// Prefix-level skip: an identifier whose info.json loads is assumed complete.
const skipPrefixes = new Set<string>();
if (verify) {
	const prefixes = new Set(
		files
			.map((f) => relative(root, f))
			.filter((k) => k.endsWith("/meta.json"))
			.map((k) => k.slice(0, -"/meta.json".length)),
	);
	let checked = 0;
	for (const p of prefixes) {
		const enc = p.split("/").map(encodeURIComponent).join("%2F");
		const res = await fetch(`${base}/iiif/3/${enc}/info.json`, { method: "HEAD" });
		if (res.status === 200) skipPrefixes.add(p);
		checked += 1;
		if (checked % 200 === 0) console.log(`  verified ${checked}/${prefixes.size}`);
	}
	console.log(`${skipPrefixes.size}/${prefixes.size} prefixes already complete`);
}

let done = 0;
let failed = 0;
const queue = files.filter((f) => {
	const key = relative(root, f);
	const prefix = key.split("/").slice(0, -1).join("/");
	return !skipPrefixes.has(prefix);
});
console.log(`${queue.length} objects to push`);

async function pushOne(file: string): Promise<void> {
	const key = relative(root, file);
	const ct = key.endsWith(".json") ? "application/json" : "image/jpeg";
	const body = await Bun.file(file).arrayBuffer();
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const res = await fetch(`${base}/ingest/${key}`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": ct },
				body,
			});
			if (res.ok) {
				done += 1;
				if (done % 250 === 0) console.log(`  ${done}/${queue.length}`);
				return;
			}
			if (res.status === 413 || res.status === 400) break;
		} catch {
			/* transient */
		}
		await Bun.sleep(attempt * 1500);
	}
	failed += 1;
	console.log(`FAIL ${key}`);
}

const workers: Promise<void>[] = [];
let cursor = 0;
for (let i = 0; i < jobs; i++) {
	workers.push(
		(async () => {
			while (cursor < queue.length) {
				const idx = cursor;
				cursor += 1;
				const f = queue[idx];
				if (f) await pushOne(f);
			}
		})(),
	);
}
await Promise.all(workers);
console.log(`done: ${done} pushed, ${failed} failed`);
if (failed > 0) process.exit(1);
