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

// Base URI → info.json redirect (baseUriRedirect feature).
app.get("/iiif/3/:collection/:leaf", (c) => {
	const id = `${c.req.param("collection")}/${c.req.param("leaf")}`;
	return c.redirect(`${c.env.PUBLIC_BASE}/${id}/info.json`, 303);
});

app.get("/iiif/3/:collection/:leaf/info.json", async (c) => {
	const id = `${c.req.param("collection")}/${c.req.param("leaf")}`;
	const stored = await loadMeta(c.env, id);
	if (!stored) return c.json({ error: "unknown identifier" }, 404, { ...CORS });
	const doc = buildInfoJson({
		id: `${c.env.PUBLIC_BASE}/${id}`,
		meta: { width: stored.width, height: stored.height, ...metaLimits(c.env) },
		scaleFactors: stored.levels,
	});
	return c.body(JSON.stringify(doc), 200, {
		...CORS,
		"Content-Type": 'application/ld+json;profile="http://iiif.io/api/image/3/context.json"',
		"Cache-Control": "public, max-age=86400",
	});
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

app.get("/iiif/3/:collection/:leaf/:region/:size/:rotation/:qualityFormat", async (c) => {
	const id = `${c.req.param("collection")}/${c.req.param("leaf")}`;
	try {
		const req = parseIIIFPath(
			c.req.param("region"),
			c.req.param("size"),
			c.req.param("rotation"),
			c.req.param("qualityFormat"),
		);
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
		const requestedPath = `${c.req.param("region")}/${c.req.param("size")}/${c.req.param("rotation")}/${c.req.param("qualityFormat")}`;
		if (requestedPath !== canonical)
			return c.redirect(`${c.env.PUBLIC_BASE}/${id}/${canonical}`, 303);

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
