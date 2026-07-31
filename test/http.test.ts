import { describe, expect, test } from "bun:test";
import app from "../src/index";

const STORED = { width: 2155, height: 3452, levels: [1, 2, 4, 8], format: "jpeg" };

/**
 * A bucket that answers metadata and reports how often it was asked. Level
 * objects are absent, so image requests reach the fetch and stop there — enough
 * to exercise everything the router decides before any pixels are touched.
 */
function bucket(version = "v1", stored: Record<string, unknown> = STORED) {
	const calls: string[] = [];
	const IMAGES = {
		async get(key: string) {
			calls.push(key);
			if (key.endsWith("meta.json")) return { json: async () => stored, etag: version, body: null };
			return null;
		},
	} as unknown as R2Bucket;
	return { IMAGES, calls };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function get(
	path: string,
	headers: Record<string, string> = {},
	version = "v1",
	opts: { base?: string; stored?: Record<string, unknown> } = {},
) {
	const env = {
		IMAGES: bucket(version, opts.stored ?? STORED).IMAGES,
		PUBLIC_BASE: opts.base ?? "https://x.test/iiif/3",
	};
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

	test("a re-ingest that changes the document invalidates the old tag", async () => {
		const first = (await get("/iiif/3/bk/info.json", {}, "v1")).headers.get("ETag") as string;
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": first }, "v2", {
			stored: { ...STORED, width: 4096 },
		});
		expect(res.status).toBe(200);
	});

	test("a re-ingest that changes nothing keeps the tag valid", async () => {
		// The tag comes from the document, so replacing meta.json with identical
		// content leaves a client's cached copy correct and it should not refetch.
		const first = (await get("/iiif/3/bk/info.json", {}, "v1")).headers.get("ETag") as string;
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": first }, "v2");
		expect(res.status).toBe(304);
	});

	test("changing PUBLIC_BASE invalidates the old tag", async () => {
		// PUBLIC_BASE reaches the document through `id`, so a client holding the
		// old tag must not be told its copy is still current.
		const first = (await get("/iiif/3/bk/info.json")).headers.get("ETag") as string;
		const res = await get("/iiif/3/bk/info.json", { "If-None-Match": first }, "v1", {
			base: "https://moved.test/iiif/3",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("ETag")).not.toBe(first);
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

/**
 * A Cache with the two methods the Worker uses, so the metadata cache can be
 * exercised for real rather than through the `caches` global, which does not
 * exist outside the Workers runtime.
 */
function stubCache() {
	const store = new Map<string, Response>();
	return {
		async match(req: Request) {
			return store.get(req.url)?.clone();
		},
		async put(req: Request, res: Response) {
			store.set(req.url, res.clone());
		},
		size: () => store.size,
		keys: () => [...store.keys()],
	};
}

describe("metadata caching", () => {
	test("a second request for the same identifier does not read R2 again", async () => {
		const b = bucket();
		const cache = stubCache();
		const env = { IMAGES: b.IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
		const { loadMetaForTest } = await import("../src/index");
		await loadMetaForTest(env, "bk", cache as unknown as Cache);
		expect(b.calls).toEqual(["bk/meta.json"]);
		const again = await loadMetaForTest(env, "bk", cache as unknown as Cache);
		expect(b.calls).toEqual(["bk/meta.json"]);
		expect(again?.stored.width).toBe(2155);
		expect(again?.version).toBe("v1");
	});

	test("an identifier that does not exist is only looked up once", async () => {
		const calls: string[] = [];
		const empty = {
			async get(key: string) {
				calls.push(key);
				return null;
			},
		} as unknown as R2Bucket;
		const b = { calls };
		const cache = stubCache();
		const env = { IMAGES: empty, PUBLIC_BASE: "https://x.test/iiif/3" };
		const { loadMetaForTest } = await import("../src/index");
		expect(await loadMetaForTest(env, "ghost", cache as unknown as Cache)).toBeNull();
		expect(await loadMetaForTest(env, "ghost", cache as unknown as Cache)).toBeNull();
		expect(b.calls).toEqual(["ghost/meta.json"]);
	});

	test("two identifiers do not share an entry", async () => {
		const b = bucket();
		const cache = stubCache();
		const env = { IMAGES: b.IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
		const { loadMetaForTest } = await import("../src/index");
		await loadMetaForTest(env, "one", cache as unknown as Cache);
		await loadMetaForTest(env, "two", cache as unknown as Cache);
		expect(b.calls).toEqual(["one/meta.json", "two/meta.json"]);
		expect(cache.size()).toBe(2);
	});

	test("an identifier with a slash gets its own key", async () => {
		const cache = stubCache();
		const env = { IMAGES: bucket().IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
		const { loadMetaForTest } = await import("../src/index");
		await loadMetaForTest(env, "book/0001", cache as unknown as Cache);
		expect(cache.keys()[0]).toContain("book%2F0001");
	});

	test.each([
		[".", ".."],
		["..", "../.."],
		["a", "./a"],
		["", "."],
	])("identifiers %p and %p never share a cache entry", async (one, two) => {
		// A path-shaped key would collapse these through dot-segment
		// normalization and let one identifier read the other's metadata.
		const cache = stubCache();
		const env = { IMAGES: bucket().IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
		const { loadMetaForTest } = await import("../src/index");
		await loadMetaForTest(env, one, cache as unknown as Cache);
		await loadMetaForTest(env, two, cache as unknown as Cache);
		expect(cache.size()).toBe(2);
	});

	test("the entry expires rather than pinning stale dimensions forever", async () => {
		const cache = stubCache();
		const env = { IMAGES: bucket().IMAGES, PUBLIC_BASE: "https://x.test/iiif/3" };
		const { loadMetaForTest } = await import("../src/index");
		await loadMetaForTest(env, "bk", cache as unknown as Cache);
		const stored = await (cache as unknown as Cache).match(new Request(cache.keys()[0] as string));
		expect(stored?.headers.get("Cache-Control")).toBe("max-age=60");
	});
});

describe("rights and partOf in the information document", () => {
	const MANIFEST = "https://x.test/collections/demo/manifest.json";

	async function info(stored: Record<string, unknown>) {
		const env = {
			IMAGES: bucket("v1", stored).IMAGES,
			PUBLIC_BASE: "https://x.test/iiif/3",
		};
		const res = await app.fetch(
			new Request("https://x.test/iiif/3/bk/info.json"),
			env,
			ctx as never,
		);
		return (await res.json()) as Record<string, unknown>;
	}

	test("neither appears when the stored metadata has neither", async () => {
		const d = await info(STORED);
		expect(d.rights).toBeUndefined();
		expect(d.partOf).toBeUndefined();
	});

	test("a Creative Commons licence is published", async () => {
		const d = await info({ ...STORED, rights: "https://creativecommons.org/licenses/by/4.0/" });
		expect(d.rights).toBe("https://creativecommons.org/licenses/by/4.0/");
	});

	test("a RightsStatements.org statement is published", async () => {
		const d = await info({ ...STORED, rights: "http://rightsstatements.org/vocab/InC/1.0/" });
		expect(d.rights).toBe("http://rightsstatements.org/vocab/InC/1.0/");
	});

	test.each([
		"not a uri",
		"https://example.com/my-own-licence",
		"CC-BY-4.0",
		"https://opensource.org/licenses/MIT",
	])("a value the spec does not permit (%p) is dropped, not published", async (rights) => {
		// The property is restricted to Creative Commons and RightsStatements.org
		// URIs, so emitting anything else would make the document non-conformant.
		expect((await info({ ...STORED, rights })).rights).toBeUndefined();
	});

	test("partOf is passed through", async () => {
		const partOf = [{ id: MANIFEST, type: "Manifest", label: { none: ["Demo"] } }];
		expect((await info({ ...STORED, partOf })).partOf).toEqual(partOf);
	});

	test("an empty partOf is omitted rather than emitted bare", async () => {
		expect((await info({ ...STORED, partOf: [] })).partOf).toBeUndefined();
	});
});

describe("where the service says it lives", () => {
	async function fetchWith(env: Record<string, unknown>, url: string, headers = {}) {
		return app.fetch(new Request(url, { headers }), env, ctx as never);
	}
	const images = () => bucket().IMAGES;

	test("with no PUBLIC_BASE the id follows the host that was asked", async () => {
		const res = await fetchWith({ IMAGES: images() }, "https://alpha.example/iiif/3/bk/info.json");
		expect(((await res.json()) as Record<string, unknown>).id).toBe(
			"https://alpha.example/iiif/3/bk",
		);
	});

	test("a different host gets a different id from the same deployment", async () => {
		const res = await fetchWith({ IMAGES: images() }, "https://beta.example/iiif/3/bk/info.json");
		expect(((await res.json()) as Record<string, unknown>).id).toBe(
			"https://beta.example/iiif/3/bk",
		);
	});

	test("an explicit PUBLIC_BASE still wins", async () => {
		const res = await fetchWith(
			{ IMAGES: images(), PUBLIC_BASE: "https://fixed.example/iiif/3" },
			"https://whatever.example/iiif/3/bk/info.json",
		);
		expect(((await res.json()) as Record<string, unknown>).id).toBe(
			"https://fixed.example/iiif/3/bk",
		);
	});

	test("a trailing slash on PUBLIC_BASE does not double up", async () => {
		const res = await fetchWith(
			{ IMAGES: images(), PUBLIC_BASE: "https://fixed.example/iiif/3/" },
			"https://x.test/iiif/3/bk/info.json",
		);
		expect(((await res.json()) as Record<string, unknown>).id).toBe(
			"https://fixed.example/iiif/3/bk",
		);
	});

	test("redirects point at the host that was asked", async () => {
		const res = await fetchWith({ IMAGES: images() }, "https://alpha.example/iiif/3/bk");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("https://alpha.example/iiif/3/bk/info.json");
	});

	test("a canonical redirect follows the same host", async () => {
		const res = await fetchWith(
			{ IMAGES: images() },
			"https://alpha.example/iiif/3/bk/full/pct:50/0/default.jpg",
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toStartWith("https://alpha.example/iiif/3/bk/");
	});
});
