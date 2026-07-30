/**
 * Compare a local ingest tree against the deployed Worker and reupload
 * anything missing or unreadable.
 *
 *   bun run scripts/verify-r2.ts /tmp/iiif-r2-prod https://iiif.example.org --bucket iiif-images [--fix]
 *
 * A prefix is complete when its info.json loads through the Worker and every
 * level listed in meta.json answers an image request that resolves to it.
 * Verification runs through the public endpoint, so it checks what viewers
 * actually see.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [root, base] = process.argv.slice(2);
const fix = process.argv.includes("--fix");
const bucketFlag = process.argv.indexOf("--bucket");
const bucket = bucketFlag >= 0 ? (process.argv[bucketFlag + 1] ?? "iiif-images") : "iiif-images";
if (!root || !base) {
	console.error(
		"usage: bun run scripts/verify-r2.ts <local-tree> <public-base> [--bucket name] [--fix]",
	);
	process.exit(1);
}

/**
 * A prefix is only complete when every level named in its meta.json answers. A
 * 64-px window of a 64f-px region resolves to exactly level f, and the output
 * stays small enough to pass any configured size ceiling.
 */
async function levelsRespond(publicBase: string, enc: string, dir: string): Promise<boolean> {
	let meta: { width: number; levels: number[] };
	try {
		meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
	} catch {
		return false;
	}
	for (const f of meta.levels) {
		const side = 64 * f;
		const res = await fetch(`${publicBase}/iiif/3/${enc}/0,0,${side},${side}/64,64/0/default.jpg`, {
			redirect: "follow",
		});
		if (res.status !== 200) return false;
		await res.arrayBuffer();
	}
	return true;
}

async function put(key: string, file: string, contentType: string): Promise<boolean> {
	for (let attempt = 1; attempt <= 4; attempt++) {
		const proc = Bun.spawn(
			[
				"bunx",
				"wrangler",
				"r2",
				"object",
				"put",
				`${bucket}/${key}`,
				"--file",
				file,
				"--content-type",
				contentType,
				"--remote",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		if ((await proc.exited) === 0) return true;
		await Bun.sleep(attempt * 3000);
	}
	return false;
}

const collections = (await readdir(root, { withFileTypes: true }))
	.filter((d) => d.isDirectory() && d.name !== "collections")
	.map((d) => d.name);

let missing = 0;
let fixed = 0;
let broken = 0;
for (const coll of collections) {
	const ids = (await readdir(join(root, coll), { withFileTypes: true }))
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	for (const id of ids) {
		const enc = `${encodeURIComponent(coll)}%2F${encodeURIComponent(id)}`;
		const res = await fetch(`${base}/iiif/3/${enc}/info.json`);
		if (res.status === 200 && (await levelsRespond(base, enc, join(root, coll, id)))) continue;
		missing += 1;
		if (!fix) {
			console.log(`MISSING ${coll}/${id} (info.json ${res.status})`);
			continue;
		}
		const dir = join(root, coll, id);
		const files = await readdir(dir);
		let ok = true;
		for (const f of files.sort()) {
			const ct = f.endsWith(".json") ? "application/json" : "image/jpeg";
			if (!(await put(`${coll}/${id}/${f}`, join(dir, f), ct))) ok = false;
		}
		if (ok) {
			fixed += 1;
			if (fixed % 20 === 0) console.log(`fixed ${fixed}/${missing} so far`);
		} else {
			broken += 1;
			console.log(`STILL FAILING ${coll}/${id}`);
		}
	}
	// collection manifest
	const mres = await fetch(`${base}/collections/${coll}/manifest.json`);
	if (mres.status !== 200 && fix) {
		await put(
			`collections/${coll}/manifest.json`,
			join(root, "collections", coll, "manifest.json"),
			"application/json",
		);
	}
}
console.log(`incomplete prefixes: ${missing}; repaired: ${fixed}; unrepaired: ${broken}`);
if (broken > 0) process.exit(1);
