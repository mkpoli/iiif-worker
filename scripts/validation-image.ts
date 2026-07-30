/**
 * Build the IIIF validator's reference image and load it into the local R2
 * simulator, so `iiif-validate.py` can be run against `wrangler dev`.
 *
 *   bun run scripts/validation-image.ts            # generate and load
 *   bun run scripts/validation-image.ts --out ./x  # also keep a copy on disk
 *
 * Then, in one terminal:
 *   wrangler dev --port 8791
 * and in another, with PUBLIC_BASE pointing at that port:
 *   uvx --from iiif-validator iiif-validate.py \
 *     -s localhost:8791 -p iiif/3 -i refimg --version 3.0 --level 2
 *
 * The validator checks pixel colours, so it only accepts its own image: a
 * 1000×1000 grid of ten by ten flat colour squares. Rather than vendor a copy
 * that could drift, the colours are read out of the installed validator, which
 * carries them as a `colorInfo` table.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const IDENTIFIER = "refimg";
const SIDE = 1000;
const CELL = 100;
const LEVELS = [1, 2, 4, 8];

const outFlag = process.argv.indexOf("--out");
const keepAt = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;

/** Read the colour table out of the installed validator package. */
async function colourGrid(): Promise<number[][][]> {
	const proc = Bun.spawn(
		[
			"uvx",
			"--from",
			"iiif-validator",
			"python",
			"-c",
			"import iiif_validator.validator as v, json; print(json.dumps(v.ValidationInfo().colorInfo))",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`could not read the validator's colour table — is uvx installed?\n${err}`);
	}
	const line = out.trim().split("\n").at(-1);
	if (!line) throw new Error("the validator produced no colour table");
	return JSON.parse(line);
}

function render(grid: number[][][]): Buffer {
	const buf = Buffer.alloc(SIDE * SIDE * 3);
	for (let y = 0; y < SIDE; y++) {
		for (let x = 0; x < SIDE; x++) {
			// The validator indexes its table as colorInfo[x][y], x horizontal.
			const cell = grid[Math.floor(x / CELL)]?.[Math.floor(y / CELL)];
			if (!cell) throw new Error("colour table is not ten by ten");
			const i = (y * SIDE + x) * 3;
			buf[i] = cell[0] as number;
			buf[i + 1] = cell[1] as number;
			buf[i + 2] = cell[2] as number;
		}
	}
	return buf;
}

async function put(key: string, file: string, contentType: string): Promise<void> {
	const proc = Bun.spawn(
		[
			"bunx",
			"wrangler",
			"r2",
			"object",
			"put",
			`iiif-images/${key}`,
			"--file",
			file,
			"--content-type",
			contentType,
			"--local",
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	if ((await proc.exited) !== 0) {
		throw new Error(`could not load ${key}: ${await new Response(proc.stderr).text()}`);
	}
}

const grid = await colourGrid();
const raw = render(grid);
const dir = keepAt ?? "/tmp/iiif-validation-image";
await mkdir(dir, { recursive: true });

const meta = { width: SIDE, height: SIDE, levels: [] as number[], format: "jpeg" as const };
for (const f of LEVELS) {
	const side = Math.floor(SIDE / f);
	const path = join(dir, `L${f}.jpg`);
	const image = sharp(raw, { raw: { width: SIDE, height: SIDE, channels: 3 } });
	// Flat colour squares survive high-quality JPEG intact, which matters: the
	// validator compares each square against its table within a tolerance of six.
	await (f === 1 ? image : image.resize(side, side, { kernel: "nearest" }))
		.jpeg({ quality: 95, mozjpeg: true })
		.toFile(path);
	meta.levels.push(f);
	await put(`${IDENTIFIER}/L${f}.jpg`, path, "image/jpeg");
}
const metaPath = join(dir, "meta.json");
await writeFile(metaPath, JSON.stringify(meta));
await put(`${IDENTIFIER}/meta.json`, metaPath, "application/json");

console.log(`loaded ${IDENTIFIER} into the local R2 simulator (${SIDE}x${SIDE}, levels ${LEVELS.join(", ")})`);
console.log("run wrangler dev, point PUBLIC_BASE at it, then:");
console.log(
	"  uvx --from iiif-validator iiif-validate.py -s localhost:8791 -p iiif/3 -i refimg --version 3.0 --level 2",
);
