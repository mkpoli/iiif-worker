/**
 * iiif-worker — IIIF Image API 3.0 server on Cloudflare Workers + R2.
 *
 * R2 layout, one prefix per image:
 *   {identifier}/meta.json          {"width","height","levels":[1,2,4,8],"format":"jpeg"}
 *   {identifier}/L{factor}.jpg      pre-rendered pyramid level (L1 = master)
 *   collections/{name}/manifest.json  IIIF Presentation 3 manifest (static)
 */

import { Hono } from "hono";
import { buildInfoJson } from "./infojson";
import { canonicalPath, IIIFError, type ImageMeta, parseIIIFPath, resolve } from "./params";
import { chooseLevel, type StoredMeta, transform } from "./pipeline";

type Bindings = {
	IMAGES: R2Bucket;
	/** Absolute public base, e.g. "https://iiif.example.org/iiif/3". */
	PUBLIC_BASE: string;
	MAX_WIDTH?: string;
	MAX_HEIGHT?: string;
	MAX_AREA?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
} as const;
const IMMUTABLE = "public, max-age=31536000, immutable";

function metaLimits(env: Bindings): Partial<ImageMeta> {
	return {
		maxWidth: env.MAX_WIDTH ? Number(env.MAX_WIDTH) : undefined,
		maxHeight: env.MAX_HEIGHT ? Number(env.MAX_HEIGHT) : undefined,
		maxArea: env.MAX_AREA ? Number(env.MAX_AREA) : undefined,
	};
}

async function loadMeta(env: Bindings, identifier: string): Promise<StoredMeta | null> {
	const obj = await env.IMAGES.get(`${identifier}/meta.json`);
	if (!obj) return null;
	return (await obj.json()) as StoredMeta;
}

app.options("*", (c) => c.body(null, 204, { ...CORS }));

/**
 * The identifier may contain URI-encoded slashes (the spec's own encoding for
 * hierarchical identifiers), so routes parse the raw, undecoded path: the
 * trailing IIIF segments are positional, everything before them is the
 * identifier. Decoding happens only after the split.
 */
function splitRawPath(c: { req: { path: string; url: string } }): string[] {
	const raw = new URL(c.req.url).pathname;
	return raw.split("/").filter((s) => s !== "");
}

function identifierFrom(segments: string[], trailing: number): string | null {
	// segments start with ["iiif", "3", ...identifier..., ...trailing...]
	const idSegs = segments.slice(2, segments.length - trailing);
	if (idSegs.length === 0) return null;
	return idSegs.map((s) => decodeURIComponent(s)).join("/");
}

// Base URI → info.json redirect (baseUriRedirect feature). A path whose last
// segment is info.json is information, never a base URI, regardless of how
// many segments the identifier occupies.
app.get("/iiif/3/:a", (c, next) => {
	const segs = splitRawPath(c);
	if (segs.at(-1) === "info.json") return next();
	const id = identifierFrom(segs, 0);
	if (!id) return c.json({ error: "missing identifier" }, 404, { ...CORS });
	return c.redirect(`${c.env.PUBLIC_BASE}/${encodeId(id)}/info.json`, 303);
});
app.get("/iiif/3/:a/:b", (c, next) => {
	const segs = splitRawPath(c);
	if (segs.at(-1) === "info.json") return next();
	const id = identifierFrom(segs, 0);
	if (!id) return c.json({ error: "missing identifier" }, 404, { ...CORS });
	return c.redirect(`${c.env.PUBLIC_BASE}/${encodeId(id)}/info.json`, 303);
});

/** Re-encode an identifier for URLs we emit (slashes kept encoded). */
function encodeId(id: string): string {
	return id.split("/").map(encodeURIComponent).join("%2F");
}

async function infoResponse(
	c: {
		env: Bindings;
		body: (b: string, s: 200, h: Record<string, string>) => Response;
		json: (o: object, s: 404, h: Record<string, string>) => Response;
	},
	id: string,
) {
	const stored = await loadMeta(c.env, id);
	if (!stored) return c.json({ error: "unknown identifier" }, 404, { ...CORS });
	const doc = buildInfoJson({
		id: `${c.env.PUBLIC_BASE}/${encodeId(id)}`,
		meta: { width: stored.width, height: stored.height, ...metaLimits(c.env) },
		scaleFactors: stored.levels,
	});
	return c.body(JSON.stringify(doc), 200, {
		...CORS,
		"Content-Type": 'application/ld+json;profile="http://iiif.io/api/image/3/context.json"',
		"Cache-Control": "public, max-age=86400",
	});
}

app.get("/iiif/3/:a/info.json", async (c) => {
	const segs = splitRawPath(c);
	const id = identifierFrom(segs, 1);
	if (!id) return c.json({ error: "missing identifier" }, 404, { ...CORS });
	return infoResponse(c, id);
});

app.get("/iiif/3/:a/:b/info.json", async (c) => {
	const segs = splitRawPath(c);
	const id = identifierFrom(segs, 1);
	if (!id) return c.json({ error: "missing identifier" }, 404, { ...CORS });
	return infoResponse(c, id);
});

app.get("/collections/:name/manifest.json", async (c) => {
	const obj = await c.env.IMAGES.get(`collections/${c.req.param("name")}/manifest.json`);
	if (!obj) return c.json({ error: "unknown collection" }, 404, { ...CORS });
	return c.body(obj.body, 200, {
		...CORS,
		"Content-Type": 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"',
		"Cache-Control": "public, max-age=86400",
	});
});

app.get("/iiif/3/*", async (c, next) => {
	const segs = splitRawPath(c);
	// ["iiif","3",...id...,region,size,rotation,"quality.format"] — at least 7.
	if (segs.length < 7) return next();
	const id = identifierFrom(segs, 4);
	if (!id) return next();
	const trailing = segs.slice(-4).map((s) => decodeURIComponent(s)) as [
		string,
		string,
		string,
		string,
	];
	try {
		const req = parseIIIFPath(...trailing);
		const stored = await loadMeta(c.env, id);
		if (!stored) return c.json({ error: "unknown identifier" }, 404, { ...CORS });
		const meta: ImageMeta = {
			width: stored.width,
			height: stored.height,
			...metaLimits(c.env),
		};
		const resolved = resolve(req, meta);

		// Canonical URI redirect keeps the cache single-keyed.
		const canonical = canonicalPath(req, resolved, meta);
		const requestedPath = trailing.join("/");
		if (requestedPath !== canonical)
			return c.redirect(`${c.env.PUBLIC_BASE}/${encodeId(id)}/${canonical}`, 303);

		// Serve from edge cache when present.
		const cacheKey = new Request(c.req.url);
		const cache = caches.default;
		const hit = await cache.match(cacheKey);
		if (hit) return hit;

		const choice = chooseLevel(resolved, stored);
		const ext = stored.format === "jpeg" ? "jpg" : stored.format;
		const levelObj = await c.env.IMAGES.get(`${id}/${choice.key}.${ext}`);
		if (!levelObj) return c.json({ error: "missing pyramid level" }, 500, { ...CORS });
		const levelBytes = new Uint8Array(await levelObj.arrayBuffer());
		const out = transform(levelBytes, choice, resolved);

		const res = new Response(out.bytes, {
			status: 200,
			headers: {
				...CORS,
				"Content-Type": out.contentType,
				"Cache-Control": IMMUTABLE,
				Link: '<http://iiif.io/api/image/3/level2.json>;rel="profile"',
			},
		});
		c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
		return res;
	} catch (e) {
		if (e instanceof IIIFError) return c.json({ error: e.message }, e.status as 400, { ...CORS });
		throw e;
	}
});

app.get("/", (c) =>
	c.json({
		service: "iiif-worker",
		image_api: `${c.env.PUBLIC_BASE}/{identifier}/info.json`,
		spec: "https://iiif.io/api/image/3.0/",
	}),
);

export default app;
