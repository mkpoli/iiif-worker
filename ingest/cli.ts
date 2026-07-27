/**
 * Ingest a folder of images into the R2 layout iiif-worker serves.
 *
 *   bun run ingest/cli.ts ./scans --collection my-book \
 *     [--label "My Book"] [--bucket iiif-images] [--base https://iiif.example.org] \
 *     [--dry-run] [--local ./r2-local]
 *
 * For each image: a JPEG pyramid (L1 full, L2 half, L4 quarter, L8 eighth),
 * a meta.json, and one Presentation 3 manifest per collection. Uploads use
 * `wrangler r2 object put` unless --local writes a directory instead (used by
 * wrangler dev's local R2 simulator or for inspection).
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";

const MAX_PIXELS = 24_000_000;
const LEVELS = [1, 2, 4, 8];

interface Args {
	folder: string;
	collection: string;
	label: string;
	bucket: string;
	base: string;
	dryRun: boolean;
	local?: string;
}

function parseArgs(argv: string[]): Args {
	const [folder, ...rest] = argv;
	if (!folder) {
		console.error(
			"usage: bun run ingest/cli.ts <folder> --collection <name> [--label ...] [--bucket ...] [--base ...] [--dry-run] [--local dir]",
		);
		process.exit(1);
	}
	const get = (flag: string): string | undefined => {
		const i = rest.indexOf(flag);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	const collection = get("--collection");
	if (!collection) {
		console.error("--collection is required");
		process.exit(1);
	}
	return {
		folder,
		collection,
		label: get("--label") ?? collection,
		bucket: get("--bucket") ?? "iiif-images",
		base: get("--base") ?? "https://iiif.mkpo.li",
		dryRun: rest.includes("--dry-run"),
		local: get("--local"),
	};
}

async function putObject(
	args: Args,
	key: string,
	data: Uint8Array | string,
	contentType: string,
): Promise<void> {
	if (args.local) {
		const path = join(args.local, key);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, data);
		return;
	}
	if (args.dryRun) {
		const size = typeof data === "string" ? data.length : data.byteLength;
		console.log(`DRY ${key} (${size} bytes, ${contentType})`);
		return;
	}
	const tmp = join("/tmp", `iiif-ingest-${crypto.randomUUID()}`);
	await writeFile(tmp, data);
	const proc = Bun.spawn(
		[
			"bunx",
			"wrangler",
			"r2",
			"object",
			"put",
			`${args.bucket}/${key}`,
			"--file",
			tmp,
			"--content-type",
			contentType,
			"--remote",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const code = await proc.exited;
	if (code !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`upload failed for ${key}: ${err}`);
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const files = (await readdir(args.folder))
		.filter((f) => /\.(jpe?g|png|webp|tiff?)$/i.test(f))
		.sort();
	if (files.length === 0) {
		console.error(`no images found in ${args.folder}`);
		process.exit(1);
	}
	console.log(`${files.length} images → collection "${args.collection}"`);

	const canvases: Record<string, unknown>[] = [];
	let done = 0;
	for (const file of files) {
		const id = basename(file, extname(file));
		const prefix = `${args.collection}/${id}`;
		const src = sharp(join(args.folder, file), { failOn: "error" });
		const meta = await src.metadata();
		const width = meta.width ?? 0;
		const height = meta.height ?? 0;
		if (width * height > MAX_PIXELS) {
			console.error(
				`${file}: ${width}x${height} exceeds ${MAX_PIXELS} pixels; ` +
					"downsample the master first (the Workers isolate memory ceiling is the reason)",
			);
			process.exit(1);
		}
		const levels: number[] = [];
		for (const f of LEVELS) {
			const w = Math.floor(width / f);
			const h = Math.floor(height / f);
			if (w < 64 || h < 64) break;
			levels.push(f);
			const buf =
				f === 1
					? await src.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer()
					: await src
							.clone()
							.resize(w, h, { kernel: "lanczos3" })
							.jpeg({ quality: 88, mozjpeg: true })
							.toBuffer();
			await putObject(args, `${prefix}/L${f}.jpg`, new Uint8Array(buf), "image/jpeg");
		}
		await putObject(
			args,
			`${prefix}/meta.json`,
			JSON.stringify({ width, height, levels, format: "jpeg" }),
			"application/json",
		);
		const imageBase = `${args.base}/iiif/3/${prefix}`;
		canvases.push({
			id: `${imageBase}/canvas`,
			type: "Canvas",
			label: { none: [id] },
			width,
			height,
			items: [
				{
					id: `${imageBase}/page`,
					type: "AnnotationPage",
					items: [
						{
							id: `${imageBase}/annotation`,
							type: "Annotation",
							motivation: "painting",
							target: `${imageBase}/canvas`,
							body: {
								id: `${imageBase}/full/max/0/default.jpg`,
								type: "Image",
								format: "image/jpeg",
								width,
								height,
								service: [{ id: imageBase, type: "ImageService3", profile: "level2" }],
							},
						},
					],
				},
			],
		});
		done += 1;
		if (done % 50 === 0 || done === files.length)
			console.log(`  ${done}/${files.length}`);
	}

	const manifest = {
		"@context": "http://iiif.io/api/presentation/3/context.json",
		id: `${args.base}/collections/${args.collection}/manifest.json`,
		type: "Manifest",
		label: { none: [args.label] },
		behavior: ["paged"],
		items: canvases,
	};
	await putObject(
		args,
		`collections/${args.collection}/manifest.json`,
		JSON.stringify(manifest),
		"application/json",
	);
	console.log("manifest written; ingest complete");
}

await main();
