/**
 * iiif-worker — IIIF Image API 3.0 server on Cloudflare Workers + R2.
 *
 * R2 layout, one prefix per image:
 *   {identifier}/meta.json          {"width","height","levels":[1,2,4,8],"format":"jpeg"}
 *   {identifier}/L{factor}.jpg      pre-rendered pyramid level (L1 = master)
 *   collections/{name}/manifest.json  IIIF Presentation 3 manifest (static)
 */

import { type Context, Hono } from "hono";
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
	"Access-Control-Allow-Headers": "Accept, Content-Type, Range",
	// Without this the canonical and profile links are invisible to browser JS,
	// which is the only reason a client would read them.
	"Access-Control-Expose-Headers": "Link, Content-Length, Content-Type",
} as const;
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Output ceiling applied when MAX_AREA is unset or unusable. An isolate has
 * 128 MB and a decoded pixel costs four bytes, so an unbounded output size
 * lets any anonymous request exhaust it. This matches the ingest CLI's source
 * ceiling, so every `max` request on an ingestible image still resolves.
 */
const DEFAULT_MAX_AREA = 12_000_000;

/** Largest body the ingest route will accept. */
const MAX_INGEST_BYTES = 100 * 1024 * 1024;

/** Env vars arrive as strings; anything not a positive number is unusable. */
function positiveLimit(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function metaLimits(env: Bindings): Partial<ImageMeta> {
	const maxHeight = positiveLimit(env.MAX_HEIGHT);
	// The spec only allows maxHeight alongside maxWidth, and reads a lone
	// maxWidth as applying to both axes, so the pair is kept symmetric here.
	const maxWidth = positiveLimit(env.MAX_WIDTH) ?? maxHeight;
	return {
		maxWidth,
		maxHeight: maxWidth === undefined ? undefined : (maxHeight ?? maxWidth),
		maxArea: positiveLimit(env.MAX_AREA) ?? DEFAULT_MAX_AREA,
	};
}

/** Stored metadata plus the R2 etag, which versions the rendered-image cache. */
interface LoadedMeta {
	stored: StoredMeta;
	version: string;
}

/**
 * How long a metadata lookup is reused. Every request needs `meta.json` before
 * it can do anything, so reading it from R2 each time puts a network round trip
 * and a class B operation in front of even a cached image. A minute of reuse
 * removes almost all of that; the cost is that a re-ingested prefix can serve
 * its previous dimensions for up to that long before healing itself.
 */
const META_TTL_SECONDS = 60;

/** A prefix that does not exist is remembered too, so a flood of requests for
 * identifiers that were never ingested cannot be turned into R2 traffic. */
const ABSENT = "absent";

function metaCacheKey(identifier: string): Request {
	// A synthetic key, never a URL anything can reach. The identifier goes in the
	// query rather than the path: a path is subject to dot-segment
	// normalization, which collapses `.` and `..` onto the same URL and would
	// let two identifiers share one entry. A query string is left alone.
	const key = new URL("https://metadata.iiif-worker.internal/");
	key.searchParams.set("id", identifier);
	return new Request(key.toString());
}

async function loadMeta(
	env: Bindings,
	identifier: string,
	cache: Cache | null,
): Promise<LoadedMeta | null> {
	const key = metaCacheKey(identifier);
	const hit = await cache?.match(key);
	if (hit) {
		const cached = (await hit.json()) as LoadedMeta | typeof ABSENT;
		return cached === ABSENT ? null : cached;
	}

	const obj = await env.IMAGES.get(`${identifier}/meta.json`);
	const loaded: LoadedMeta | null = obj
		? { stored: (await obj.json()) as StoredMeta, version: obj.etag }
		: null;

	await cache?.put(
		key,
		new Response(JSON.stringify(loaded ?? ABSENT), {
			headers: { "Cache-Control": `max-age=${META_TTL_SECONDS}` },
		}),
	);
	return loaded;
}

/**
 * An entity tag for a response whose bytes are already fixed by its URL. R2
 * hands back the stored object's etag, which changes whenever a prefix is
 * re-ingested, so it identifies the content.
 */
function entityTag(...parts: string[]): string {
	return `"${parts.join("-").replace(/"/g, "")}"`;
}

/**
 * An entity tag taken from the representation itself. Listing the inputs that
 * feed a document by hand invites leaving one out — the configured public base
 * reaches the document through `id` and is easy to forget — so the bytes on the
 * wire are hashed instead and nothing can drift out of the tag.
 */
async function digestTag(...parts: string[]): Promise<string> {
	const data = new TextEncoder().encode(parts.join("\u0000"));
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	const hex = Array.from(hash.slice(0, 16))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `"${hex}"`;
}

/**
 * `If-None-Match` is a list, and `*` matches anything. A weak comparison is the
 * right one for cache revalidation, so a `W/` prefix on either side is ignored.
 */
function etagMatches(header: string | undefined, tag: string): boolean {
	if (!header) return false;
	const bare = (t: string) => t.trim().replace(/^W\//, "");
	if (header.trim() === "*") return true;
	return header.split(",").some((candidate) => bare(candidate) === bare(tag));
}

/** 304 carries the headers that would have validated the cached copy. */
function notModified(headers: Record<string, string>): Response {
	return new Response(null, { status: 304, headers });
}

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { ...CORS, "Content-Type": "application/json" },
	});
}

/** A 303 to the canonical location, carrying CORS so browsers can follow it. */
function seeOther(location: string): Response {
	// The mapping from a request spelling to its canonical form never changes,
	// so a viewer that keeps asking in its own dialect pays for the hop once
	// rather than once per tile.
	return new Response(null, {
		status: 303,
		headers: { ...CORS, Location: location, "Cache-Control": IMMUTABLE },
	});
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

const LD_JSON = 'application/ld+json;profile="http://iiif.io/api/image/3/context.json"';

/**
 * Section 5.1 asks for JSON-LD by default and for content negotiation when the
 * client states a preference, so a client that asks only for `application/json`
 * gets plain JSON rather than a media type it said it would not take.
 */
function infoContentType(accept: string | undefined): string {
	if (!accept) return LD_JSON;
	if (accept.includes("application/ld+json")) return LD_JSON;
	if (accept.includes("application/json")) return "application/json";
	return LD_JSON;
}

async function infoResponse(
	env: Bindings,
	id: string,
	accept: string | undefined,
	ifNoneMatch: string | undefined,
): Promise<Response> {
	const loaded = await loadMeta(env, id, edgeCache());
	if (!loaded) return jsonError(404, "unknown identifier");
	const { stored } = loaded;
	const contentType = infoContentType(accept);
	const doc = buildInfoJson({
		id: `${env.PUBLIC_BASE}/${encodeId(id)}`,
		meta: { width: stored.width, height: stored.height, ...metaLimits(env) },
		scaleFactors: stored.levels,
		rights: stored.rights,
		partOf: stored.partOf,
	});
	const body = JSON.stringify(doc);
	// The media type joins the body because the two negotiated forms carry the
	// same bytes under different types, and those are separate representations.
	const tag = await digestTag(contentType, body);
	const headers = {
		...CORS,
		"Content-Type": contentType,
		Vary: "Accept",
		"Cache-Control": "public, max-age=86400",
		ETag: tag,
	};
	if (etagMatches(ifNoneMatch, tag)) return notModified(headers);
	return new Response(body, { status: 200, headers });
}

app.get("/collections/:name/manifest.json", async (c) => {
	const obj = await c.env.IMAGES.get(`collections/${c.req.param("name")}/manifest.json`);
	if (!obj) return jsonError(404, "unknown collection");
	return c.body(obj.body, 200, {
		...CORS,
		"Content-Type": 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"',
		"Cache-Control": "public, max-age=86400",
	});
});

/**
 * The rendered-image cache key. The query string never affects the pixels, so
 * dropping it stops `?nonce=1`, `?nonce=2`, … from forcing a fresh decode per
 * request. The meta.json etag rides along in its place, so re-ingesting an
 * identifier moves every derivative to a fresh key instead of leaving the old
 * pixels served under `immutable` for a year.
 */
function renderCacheKey(url: string, version: string): Request {
	const u = new URL(url);
	u.search = `?v=${encodeURIComponent(version)}`;
	return new Request(u.toString());
}

/** `caches` is absent outside the Workers runtime, e.g. under a unit test. */
function edgeCache(): Cache | null {
	return typeof caches === "undefined" ? null : caches.default;
}

async function imageResponse(
	c: Context<{ Bindings: Bindings }>,
	id: string,
	trailing: [string, string, string, string],
): Promise<Response> {
	const req = parseIIIFPath(...trailing);
	const cache = edgeCache();
	const loaded = await loadMeta(c.env, id, cache);
	if (!loaded) return jsonError(404, "unknown identifier");
	const { stored, version } = loaded;
	const meta: ImageMeta = { width: stored.width, height: stored.height, ...metaLimits(c.env) };
	const resolved = resolve(req, meta);

	// Canonical URI redirect keeps the cache single-keyed.
	const canonical = canonicalPath(resolved, meta);
	const canonicalUrl = `${c.env.PUBLIC_BASE}/${encodeId(id)}/${canonical}`;
	if (trailing.join("/") !== canonical) return seeOther(canonicalUrl);

	// The canonical URL fixes every pixel of the output, so the stored version is
	// all that has to change for the bytes to change.
	const tag = entityTag(version);
	if (etagMatches(c.req.header("If-None-Match"), tag))
		return notModified({ ...CORS, "Cache-Control": IMMUTABLE, ETag: tag });

	const cacheKey = renderCacheKey(c.req.url, version);
	const hit = await cache?.match(cacheKey);
	if (hit) return hit;

	const choice = chooseLevel(resolved, stored);
	const ext = stored.format === "jpeg" ? "jpg" : stored.format;
	const levelObj = await c.env.IMAGES.get(`${id}/${choice.key}.${ext}`);
	if (!levelObj)
		return jsonError(500, `meta.json lists level ${choice.key} but the object is absent`);
	const out = transform(new Uint8Array(await levelObj.arrayBuffer()), choice, resolved);

	const res = new Response(out.bytes, {
		status: 200,
		headers: {
			...CORS,
			"Content-Type": out.contentType,
			"Cache-Control": IMMUTABLE,
			ETag: tag,
			Link:
				`<${canonicalUrl}>;rel="canonical", ` +
				'<http://iiif.io/api/image/3/level2.json>;rel="profile"',
		},
	});
	if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
	return res;
}

/**
 * One dispatcher for every image-API URL. The identifier is whatever precedes
 * the positional trailing segments, so it works whether the client encoded its
 * slashes (as the spec directs) or left them bare.
 */
app.get("/iiif/3/*", async (c) => {
	const rest = splitRawPath(c.req.url).slice(2);
	try {
		if (rest.length === 0) return jsonError(404, "missing identifier");

		if (rest.at(-1) === "info.json") {
			if (rest.length < 2) return jsonError(404, "missing identifier");
			return await infoResponse(
				c.env,
				decodeId(rest.slice(0, -1)),
				c.req.header("Accept"),
				c.req.header("If-None-Match"),
			);
		}

		// An image request is an identifier plus region/size/rotation/quality.format,
		// and only the last of those carries a format extension.
		if (rest.length >= 5 && rest[rest.length - 1]?.includes(".")) {
			const trailing = rest.slice(-4).map(decodeSegment) as [string, string, string, string];
			return await imageResponse(c, decodeId(rest.slice(0, -4)), trailing);
		}

		// Everything else is a base URI, which redirects to its info.json.
		return seeOther(`${c.env.PUBLIC_BASE}/${encodeId(decodeId(rest))}/info.json`);
	} catch (e) {
		if (e instanceof IIIFError) return jsonError(e.status, e.message);
		throw e;
	}
});

/**
 * Constant-time bearer check. A plain `!==` on the token returns as soon as
 * two bytes differ, which times out the guess character by character.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
	if (!header) return false;
	const a = new TextEncoder().encode(header);
	const b = new TextEncoder().encode(`Bearer ${token}`);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

/**
 * Token-gated ingest: the CLI PUTs objects through the Worker instead of the
 * Cloudflare API, which keeps bulk loads on the same S3-free path and out of
 * the management API's rate budget. Disabled unless INGEST_TOKEN is set.
 */
app.put("/ingest/:key{.+}", async (c) => {
	const token = c.env.INGEST_TOKEN;
	if (!token) return jsonError(404, "ingest disabled");
	if (!bearerMatches(c.req.header("Authorization"), token)) return jsonError(403, "unauthorized");

	let key: string;
	try {
		key = decodeURIComponent(new URL(c.req.url).pathname.slice("/ingest/".length));
	} catch {
		return jsonError(400, "malformed percent-encoding in key");
	}
	if (!key || key.includes("..")) return jsonError(400, "bad key");

	// The body streams straight into R2, so the declared length is the only
	// chance to reject an oversized upload before it costs isolate memory.
	const declared = Number(c.req.header("Content-Length"));
	if (!Number.isInteger(declared) || declared <= 0)
		return jsonError(411, "Content-Length required");
	if (declared > MAX_INGEST_BYTES) return jsonError(413, "too large");
	const body = c.req.raw.body;
	if (!body) return jsonError(400, "empty body");

	await c.env.IMAGES.put(key, body, {
		httpMetadata: {
			contentType: c.req.header("Content-Type") ?? "application/octet-stream",
		},
	});
	return c.json({ ok: true, key, bytes: declared });
});

app.get("/", (c) =>
	c.json({
		service: "iiif-worker",
		image_api: `${c.env.PUBLIC_BASE}/{identifier}/info.json`,
		spec: "https://iiif.io/api/image/3.0/",
	}),
);

/** Exposed so the metadata cache can be tested against a stub Cache. */
export const loadMetaForTest = loadMeta;

app.notFound(() => jsonError(404, "not found"));
app.onError((e) => {
	if (e instanceof IIIFError) return jsonError(e.status, e.message);
	return jsonError(500, "internal error");
});

export default app;
