/**
 * IIIF Image API 3.0 request parsing, validation, and canonicalization.
 * https://iiif.io/api/image/3.0/
 *
 * Pure module: no I/O, no Workers types. Everything here is unit-tested
 * against the syntax tables of the specification.
 */

export interface ImageMeta {
	/** Full width of the source image in pixels. */
	width: number;
	/** Full height of the source image in pixels. */
	height: number;
	/** Server-enforced ceilings; absent means unlimited. */
	maxWidth?: number;
	maxHeight?: number;
	maxArea?: number;
}

export interface RegionFull {
	kind: "full";
}
export interface RegionSquare {
	kind: "square";
}
export interface RegionPixels {
	kind: "pixels";
	x: number;
	y: number;
	w: number;
	h: number;
}
export interface RegionPercent {
	kind: "pct";
	x: number;
	y: number;
	w: number;
	h: number;
}
export type Region = RegionFull | RegionSquare | RegionPixels | RegionPercent;

export interface SizeMax {
	kind: "max";
	upscale: boolean;
}
export interface SizeWidth {
	kind: "w";
	upscale: boolean;
	w: number;
}
export interface SizeHeight {
	kind: "h";
	upscale: boolean;
	h: number;
}
export interface SizePercent {
	kind: "pct";
	upscale: boolean;
	n: number;
}
export interface SizeExact {
	kind: "wh";
	upscale: boolean;
	w: number;
	h: number;
}
export interface SizeConfined {
	kind: "confined";
	upscale: boolean;
	w: number;
	h: number;
}
export type Size = SizeMax | SizeWidth | SizeHeight | SizePercent | SizeExact | SizeConfined;

export interface Rotation {
	mirror: boolean;
	degrees: number;
}

export const QUALITIES = ["default", "color", "gray", "bitonal"] as const;
export type Quality = (typeof QUALITIES)[number];

export const FORMATS = ["jpg", "png", "webp"] as const;
export type Format = (typeof FORMATS)[number];

export interface IIIFRequest {
	region: Region;
	size: Size;
	rotation: Rotation;
	quality: Quality;
	format: Format;
}

/** A pixel rectangle on the source image. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ResolvedRequest {
	/** Region resolved to source pixels, clipped to image bounds. */
	rect: Rect;
	/** Output dimensions before rotation. */
	outW: number;
	outH: number;
	/** The requested size was `max`/`^max`, so the canonical form keeps `max`. */
	sizeIsMax: boolean;
	rotation: Rotation;
	quality: Quality;
	format: Format;
}

export class IIIFError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const INT = /^\d+$/;
const FLOAT = /^\d+(?:\.\d+)?$/;

function parseFloatStrict(s: string): number {
	if (!FLOAT.test(s)) throw new IIIFError(400, `malformed number: ${s}`);
	return Number.parseFloat(s);
}

/** Parse the region path segment. */
export function parseRegion(segment: string): Region {
	if (segment === "full") return { kind: "full" };
	if (segment === "square") return { kind: "square" };
	const pct = segment.startsWith("pct:");
	const body = pct ? segment.slice(4) : segment;
	const parts = body.split(",");
	if (parts.length !== 4) throw new IIIFError(400, `malformed region: ${segment}`);
	if (pct) {
		const [x, y, w, h] = parts.map(parseFloatStrict) as [number, number, number, number];
		if (w <= 0 || h <= 0) throw new IIIFError(400, `degenerate region: ${segment}`);
		if (x >= 100 || y >= 100) throw new IIIFError(400, `region out of bounds: ${segment}`);
		return { kind: "pct", x, y, w, h };
	}
	for (const p of parts) if (!INT.test(p)) throw new IIIFError(400, `malformed region: ${segment}`);
	const [x, y, w, h] = parts.map((p) => Number.parseInt(p, 10)) as [number, number, number, number];
	if (w <= 0 || h <= 0) throw new IIIFError(400, `degenerate region: ${segment}`);
	return { kind: "pixels", x, y, w, h };
}

/** Parse the size path segment. */
export function parseSize(segment: string): Size {
	const upscale = segment.startsWith("^");
	const body = upscale ? segment.slice(1) : segment;
	if (body === "max") return { kind: "max", upscale };
	if (body.startsWith("pct:")) {
		const n = parseFloatStrict(body.slice(4));
		if (n <= 0) throw new IIIFError(400, `degenerate size: ${segment}`);
		if (!upscale && n > 100) throw new IIIFError(400, `size over 100% needs ^: ${segment}`);
		return { kind: "pct", upscale, n };
	}
	const confined = body.startsWith("!");
	const dims = (confined ? body.slice(1) : body).split(",");
	if (dims.length !== 2) throw new IIIFError(400, `malformed size: ${segment}`);
	const [ws, hs] = dims as [string, string];
	if (confined) {
		if (!INT.test(ws) || !INT.test(hs)) throw new IIIFError(400, `malformed size: ${segment}`);
		const w = Number.parseInt(ws, 10);
		const h = Number.parseInt(hs, 10);
		if (w <= 0 || h <= 0) throw new IIIFError(400, `degenerate size: ${segment}`);
		return { kind: "confined", upscale, w, h };
	}
	if (ws !== "" && hs !== "") {
		if (!INT.test(ws) || !INT.test(hs)) throw new IIIFError(400, `malformed size: ${segment}`);
		const w = Number.parseInt(ws, 10);
		const h = Number.parseInt(hs, 10);
		if (w <= 0 || h <= 0) throw new IIIFError(400, `degenerate size: ${segment}`);
		return { kind: "wh", upscale, w, h };
	}
	if (ws !== "") {
		if (!INT.test(ws)) throw new IIIFError(400, `malformed size: ${segment}`);
		const w = Number.parseInt(ws, 10);
		if (w <= 0) throw new IIIFError(400, `degenerate size: ${segment}`);
		return { kind: "w", upscale, w };
	}
	if (hs !== "") {
		if (!INT.test(hs)) throw new IIIFError(400, `malformed size: ${segment}`);
		const h = Number.parseInt(hs, 10);
		if (h <= 0) throw new IIIFError(400, `degenerate size: ${segment}`);
		return { kind: "h", upscale, h };
	}
	throw new IIIFError(400, `malformed size: ${segment}`);
}

/** Parse the rotation path segment. */
export function parseRotation(segment: string): Rotation {
	const mirror = segment.startsWith("!");
	const body = mirror ? segment.slice(1) : segment;
	if (!FLOAT.test(body)) throw new IIIFError(400, `malformed rotation: ${segment}`);
	const degrees = Number.parseFloat(body);
	if (degrees < 0 || degrees > 360) throw new IIIFError(400, `rotation out of range: ${segment}`);
	return { mirror, degrees: degrees % 360 };
}

/** Parse the quality.format path segment. */
export function parseQualityFormat(segment: string): {
	quality: Quality;
	format: Format;
} {
	const dot = segment.lastIndexOf(".");
	if (dot < 0) throw new IIIFError(400, `missing format: ${segment}`);
	const quality = segment.slice(0, dot) as Quality;
	const format = segment.slice(dot + 1) as Format;
	if (!QUALITIES.includes(quality)) throw new IIIFError(400, `unknown quality: ${quality}`);
	if (!FORMATS.includes(format)) throw new IIIFError(400, `unsupported format: ${format}`);
	return { quality, format };
}

/** Parse the four IIIF path segments after the identifier. */
export function parseIIIFPath(
	regionSeg: string,
	sizeSeg: string,
	rotationSeg: string,
	qualityFormatSeg: string,
): IIIFRequest {
	return {
		region: parseRegion(regionSeg),
		size: parseSize(sizeSeg),
		rotation: parseRotation(rotationSeg),
		...parseQualityFormat(qualityFormatSeg),
	};
}

/** Resolve a region against source dimensions, clipping to bounds. */
export function resolveRegion(region: Region, meta: ImageMeta): Rect {
	const { width, height } = meta;
	let rect: Rect;
	switch (region.kind) {
		case "full":
			rect = { x: 0, y: 0, w: width, h: height };
			break;
		case "square": {
			const s = Math.min(width, height);
			rect = {
				x: Math.floor((width - s) / 2),
				y: Math.floor((height - s) / 2),
				w: s,
				h: s,
			};
			break;
		}
		case "pct":
			rect = {
				x: Math.round((region.x / 100) * width),
				y: Math.round((region.y / 100) * height),
				w: Math.round((region.w / 100) * width),
				h: Math.round((region.h / 100) * height),
			};
			break;
		case "pixels":
			rect = { x: region.x, y: region.y, w: region.w, h: region.h };
			break;
	}
	if (rect.x >= width || rect.y >= height)
		throw new IIIFError(400, "region entirely outside image");
	// Clip to image bounds.
	const w = Math.min(rect.w, width - rect.x);
	const h = Math.min(rect.h, height - rect.y);
	if (w <= 0 || h <= 0) throw new IIIFError(400, "region has no pixels");
	return { x: rect.x, y: rect.y, w, h };
}

/**
 * A service that declares `maxWidth` without `maxHeight` is declaring the same
 * ceiling on both axes, so the pair is normalized wherever it is read.
 * https://iiif.io/api/image/3.0/#52-technical-properties
 */
function heightLimit(meta: ImageMeta): number {
	return meta.maxHeight ?? meta.maxWidth ?? Number.POSITIVE_INFINITY;
}

/** Largest scale factor for which w×h still satisfies every server ceiling. */
function limitScale(w: number, h: number, meta: ImageMeta): number {
	return Math.min(
		(meta.maxWidth ?? Number.POSITIVE_INFINITY) / w,
		heightLimit(meta) / h,
		Math.sqrt((meta.maxArea ?? Number.POSITIVE_INFINITY) / (w * h)),
	);
}

/**
 * The dimensions `max` and `^max` resolve to. `max` fills the server ceilings
 * without ever enlarging; `^max` scales up to them. With no ceiling configured
 * there is nothing to scale up to, so `^max` yields the region unchanged.
 *
 * The server picks these dimensions itself, so a ceiling small enough to round
 * an axis to zero clamps to one pixel rather than failing the request.
 */
export function maxDimensions(
	rect: Rect,
	meta: ImageMeta,
	upscale: boolean,
): { outW: number; outH: number } {
	const raw = limitScale(rect.w, rect.h, meta);
	const scale = upscale ? raw : Math.min(1, raw);
	if (!Number.isFinite(scale) || scale === 1) return { outW: rect.w, outH: rect.h };
	return {
		outW: Math.max(1, Math.floor(rect.w * scale)),
		outH: Math.max(1, Math.floor(rect.h * scale)),
	};
}

/** Resolve a size against a resolved region, applying spec rules. */
export function resolveSize(
	size: Size,
	rect: Rect,
	meta: ImageMeta,
): { outW: number; outH: number } {
	const maxW = meta.maxWidth ?? Number.POSITIVE_INFINITY;
	const maxH = heightLimit(meta);
	const maxArea = meta.maxArea ?? Number.POSITIVE_INFINITY;

	let outW: number;
	let outH: number;
	switch (size.kind) {
		case "max": {
			return maxDimensions(rect, meta, size.upscale);
		}
		case "w":
			outW = size.w;
			outH = Math.round((rect.h / rect.w) * size.w);
			break;
		case "h":
			outH = size.h;
			outW = Math.round((rect.w / rect.h) * size.h);
			break;
		case "pct":
			outW = Math.round((rect.w * size.n) / 100);
			outH = Math.round((rect.h * size.n) / 100);
			break;
		case "wh":
			outW = size.w;
			outH = size.h;
			break;
		case "confined": {
			// The result is as large as possible while fitting inside the box, the
			// server ceilings, and — without `^` — the region itself. A box larger
			// than any of those shrinks the scale rather than failing the request.
			let scale = Math.min(size.w / rect.w, size.h / rect.h, limitScale(rect.w, rect.h, meta));
			if (!size.upscale) scale = Math.min(1, scale);
			outW = Math.round(rect.w * scale);
			outH = Math.round(rect.h * scale);
			// Rounding each axis to its nearest pixel can carry the pair back over
			// maxArea. This form has to fit inside the ceilings rather than fail, so
			// the longer side gives up pixels until it does.
			while (outW * outH > maxArea && (outW > 1 || outH > 1)) {
				if (outW >= outH) outW -= 1;
				else outH -= 1;
			}
			break;
		}
	}
	// A client-specified size that scales an axis below one pixel has no image
	// to return.
	if (outW < 1 || outH < 1) throw new IIIFError(400, "size rounds to zero pixels");
	if (!size.upscale && (outW > rect.w || outH > rect.h))
		throw new IIIFError(400, "size exceeds region; prefix with ^ to allow upscaling");
	if (outW > maxW || outH > maxH || outW * outH > maxArea)
		throw new IIIFError(400, "size exceeds server limits");
	return { outW, outH };
}

/** Fully resolve a parsed request against image metadata. */
export function resolve(req: IIIFRequest, meta: ImageMeta): ResolvedRequest {
	const rect = resolveRegion(req.region, meta);
	const { outW, outH } = resolveSize(req.size, rect, meta);
	return {
		rect,
		outW,
		outH,
		sizeIsMax: req.size.kind === "max",
		rotation: req.rotation,
		quality: req.quality,
		format: req.format,
	};
}

/**
 * The rotation syntax admits decimal digits and a point, nothing else, but
 * `String()` switches to exponent notation below 1e-6. Expanding the exponent
 * keeps the value intact; rounding to fixed decimals would not, turning a
 * requested 1.23456789 into a different image at 1.234568.
 */
function decimalDegrees(n: number): string {
	const s = String(n);
	if (!s.includes("e") && !s.includes("E")) return s;
	const [mantissa, exponent] = s.split(/[eE]/) as [string, string];
	const exp = Number(exponent);
	const point = mantissa.indexOf(".");
	const digits = mantissa.replace(".", "");
	const shift = (point === -1 ? mantissa.length : point) + exp;
	if (shift <= 0) return `0.${"0".repeat(-shift)}${digits}`;
	if (shift >= digits.length) return digits + "0".repeat(shift - digits.length);
	return `${digits.slice(0, shift)}.${digits.slice(shift)}`;
}

/**
 * The canonical form of a request per the spec's Canonical URI Syntax:
 * region as `full` or `x,y,w,h`; size as `max`/`^max` or `w,h` (with `^`
 * when upscaling was requested); rotation without trailing zeros; the
 * `default` quality.
 */
export function canonicalPath(resolved: ResolvedRequest, meta: ImageMeta): string {
	const { rect, outW, outH } = resolved;
	const regionSeg =
		rect.x === 0 && rect.y === 0 && rect.w === meta.width && rect.h === meta.height
			? "full"
			: `${rect.x},${rect.y},${rect.w},${rect.h}`;
	// `^` belongs in the canonical form when the result is genuinely larger than
	// the region, whatever prefix the client happened to write.
	const caret = outW > rect.w || outH > rect.h ? "^" : "";
	const sizeSeg = resolved.sizeIsMax ? `${caret}max` : `${caret}${outW},${outH}`;

	const degSeg = decimalDegrees(resolved.rotation.degrees);
	const rotationSeg = `${resolved.rotation.mirror ? "!" : ""}${degSeg}`;

	// `color` is this server's default rendering, so it canonicalizes to
	// `default`; the other qualities name a distinct rendering and stay.
	const quality = resolved.quality === "color" ? "default" : resolved.quality;
	return `${regionSeg}/${sizeSeg}/${rotationSeg}/${quality}.${resolved.format}`;
}
