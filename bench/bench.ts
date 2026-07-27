/**
 * Latency benchmark for IIIF Image API endpoints.
 *
 *   bun run bench/bench.ts https://iiif.example.org/iiif/3/collection/0011 [runs]
 *
 * Requests four classes against one image: info.json, a 512×512 tile,
 * a mid-size region scaled down, and a full-region thumbnail. Reports
 * cold (first) and warm percentiles per class. Cache behavior is whatever
 * the target serves; run twice to separate fill from steady state.
 */

const base = process.argv[2];
const runs = Number(process.argv[3] ?? 20);
if (!base) {
	console.error("usage: bun run bench/bench.ts <image-base-url> [runs]");
	process.exit(1);
}

const CLASSES: Record<string, string> = {
	"info.json": `${base}/info.json`,
	"tile 512": `${base}/0,0,1024,1024/512,512/0/default.jpg`,
	"region scaled": `${base}/300,2000,1600,400/800,200/0/default.jpg`,
	"full !600": `${base}/full/!600,600/0/default.jpg`,
};

function pct(sorted: number[], p: number): number {
	const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, i)] ?? 0;
}

async function timeOne(url: string): Promise<{ ms: number; status: number; bytes: number }> {
	const t0 = performance.now();
	const res = await fetch(url, { redirect: "follow" });
	const buf = await res.arrayBuffer();
	return { ms: performance.now() - t0, status: res.status, bytes: buf.byteLength };
}

console.log(`target: ${base}  runs: ${runs}`);
for (const [name, url] of Object.entries(CLASSES)) {
	const cold = await timeOne(url);
	const warm: number[] = [];
	for (let i = 0; i < runs; i++) {
		const r = await timeOne(url);
		if (r.status !== 200) {
			console.log(`${name}: HTTP ${r.status} — skipping class`);
			break;
		}
		warm.push(r.ms);
	}
	warm.sort((a, b) => a - b);
	console.log(
		`${name.padEnd(14)} cold ${cold.ms.toFixed(0).padStart(5)}ms (${cold.status}, ${cold.bytes}b)  ` +
			`warm p50 ${pct(warm, 50).toFixed(0)}ms  p90 ${pct(warm, 90).toFixed(0)}ms  p99 ${pct(warm, 99).toFixed(0)}ms`,
	);
}

export {};
