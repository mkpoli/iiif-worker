import { describe, expect, test } from "bun:test";
import app from "../src/index";

const STORED = { width: 2155, height: 3452, levels: [1, 2, 4, 8], format: "jpeg" };

/**
 * A bucket that answers metadata and reports how often it was asked. Level
 * objects are absent, so image requests reach the fetch and stop there — enough
 * to exercise everything the router decides before any pixels are touched.
 */
function bucket(version = "v1") {
	const calls: string[] = [];
	const IMAGES = {
		async get(key: string) {
			calls.push(key);
			if (key.endsWith("meta.json")) return { json: async () => STORED, etag: version, body: null };
			return null;
		},
	} as unknown as R2Bucket;
	return { IMAGES, calls };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function get(path: string, headers: Record<string, string> = {}, version = "v1") {
	const env = { IMAGES: bucket(version).IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
	return app.fetch(new Request(`https://x.test${path}`, { headers }), env, ctx as never);
}

describe("conditional requests on the information document", () => {
	test("the response carries an ETag", async () => {
		const res = await get("/iiif/3/bk/info.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("ETag")).toMatch(/^".+"$/);
	});

	test("a matching If-None-Match gets 304 with no body", async () => {
		const tag = (await get("/iiif/3/bk/info.json")).headers.get("ETag") as string;
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": tag });
		expect(res.status).toBe(304);
		expect(await res.text()).toBe("");
		expect(res.headers.get("ETag")).toBe(tag);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
	});

	test("a stale If-None-Match gets the document", async () => {
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": '"something-else"' });
		expect(res.status).toBe(200);
	});

	test("* matches anything", async () => {
		expect((await get("/iiif/3/bk/info.json", { "If-None-Match": "*" })).status).toBe(304);
	});

	test("a weak tag still validates", async () => {
		const tag = (await get("/iiif/3/bk/info.json")).headers.get("ETag") as string;
		expect((await get("/iiif/3/bk/info.json", { "If-None-Match": `W/${tag}` })).status).toBe(304);
	});

	test("one tag among several validates", async () => {
		const tag = (await get("/iiif/3/bk/info.json")).headers.get("ETag") as string;
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": `"other", ${tag}` });
		expect(res.status).toBe(304);
	});

	test("re-ingesting the prefix invalidates the old tag", async () => {
		const first = (await get("/iiif/3/bk/info.json", {}, "v1")).headers.get("ETag") as string;
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": first }, "v2");
		expect(res.status).toBe(200);
	});

	test("the negotiated media type changes the tag", async () => {
		const ld = (await get("/iiif/3/bk/info.json")).headers.get("ETag");
		const plain = (await get("/iiif/3/bk/info.json", { Accept: "application/json" })).headers.get(
			"ETag",
		);
		expect(ld).not.toBe(plain);
	});
});

describe("conditional requests on images", () => {
	test("a matching tag short-circuits before the level is read", async () => {
		const b = bucket();
		const env = { IMAGES: b.IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
		const url = "https://x.test/iiif/3/bk/0,0,512,512/512,512/0/default.jpg";
		const first = await app.fetch(new Request(url), env, ctx as never);
		// No level objects exist, so an uncached render fails at the fetch.
		expect(first.status).toBe(500);
		const tag = '"v1"';
		const res = await app.fetch(
			new Request(url, { headers: { "If-None-Match": tag } }),
			env,
			ctx as never,
		);
		expect(res.status).toBe(304);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
	});

	test("a redirect to the canonical form is not short-circuited", async () => {
		const res = await get("/iiif/3/bk/full/pct:50/0/default.jpg", { "If-None-Match": "*" });
		expect(res.status).toBe(303);
	});
});
