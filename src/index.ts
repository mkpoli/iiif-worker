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
	/** Secret enabling the /ingest PUT route; unset disables ingest entirely. */
	INGEST_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
} as const;
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Output ceiling applied when MAX_AREA is unset or unusable. An isolate has
 * 128 MB and a decoded pixel costs four bytes, so an unbounded output size is
 * a way for any anonymous request to exhaust the isolate. This value matches
 * the ingest CLI's source ceiling, so every `max` request on an ingestible
 * image still resolves.
 */
const DEFAULT_MAX_AREA = 25_000_000;

/** Env vars arrive as strings; anything not a positive number is unusable. */
function positiveLimit(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function metaLimits(env: Bindings): Partial<ImageMeta> {
	return {
		maxWidth: positiveLimit(env.MAX_WIDTH),
		maxHeight: positiveLimit(env.MAX_HEIGHT),
		maxArea: positiveLimit(env.MAX_AREA) ?? DEFAULT_MAX_AREA,
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
 * hierarchical identifiers), so routing works on the raw, undecoded path: the
 * trailing IIIF segments are positional, everything before them is the
 * identifier. Decoding happens only after the split.
 */
function splitRawPath(url: string): string[] {
	return new URL(url).pathname.split("/").filter((s) => s !== "");
}

/** Decode path segments into an identifier, rejecting invalid escapes. */
function decodeId(segments: string[]): string {
	try {
		return segments.map((s) => decodeURIComponent(s)).join("/");
	} catch {
		throw new IIIFError(400, "malformed percent-encoding in identifier");
	}
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new IIIFError(400, "malformed percent-encoding in request");
	}
}

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

/**
 * Token-gated ingest: the CLI PUTs objects through the Worker instead of the
 * Cloudflare API, which keeps bulk loads on the same S3-free path and out of
 * the management API's rate budget. Disabled unless INGEST_TOKEN is set.
 */
app.put("/ingest/:key{.+}", async (c) => {
	const token = c.env.INGEST_TOKEN;
	if (!token) return c.json({ error: "ingest disabled" }, 404);
	const got = c.req.header("Authorization");
	if (got !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 403);
	const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/ingest/".length));
	if (!key || key.includes("..")) return c.json({ error: "bad key" }, 400);
	const body = await c.req.arrayBuffer();
	if (body.byteLength === 0) return c.json({ error: "empty body" }, 400);
	if (body.byteLength > 100 * 1024 * 1024) return c.json({ error: "too large" }, 413);
	await c.env.IMAGES.put(key, body, {
		httpMetadata: {
			contentType: c.req.header("Content-Type") ?? "application/octet-stream",
		},
	});
	return c.json({ ok: true, key, bytes: body.byteLength });
});

app.get("/", (c) =>
	c.json({
		service: "iiif-worker",
		image_api: `${c.env.PUBLIC_BASE}/{identifier}/info.json`,
		spec: "https://iiif.io/api/image/3.0/",
	}),
);

export default app;
