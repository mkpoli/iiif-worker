/** ImageService3 info.json builder. https://iiif.io/api/image/3.0/#5-image-information */

import type { ImageMeta } from "./params";

export interface InfoOptions {
	/** Absolute base URI of this image, no trailing slash. */
	id: string;
	meta: ImageMeta;
	/** Pyramid scale denominators available as pre-rendered levels, e.g. [1,2,4,8]. */
	scaleFactors: number[];
	tileSize?: number;
	rights?: string;
	partOf?: { id: string; type: string; label?: Record<string, string[]> }[];
}

export function buildInfoJson(o: InfoOptions): Record<string, unknown> {
	const { meta } = o;
	const tileSize = o.tileSize ?? 512;
	const maxW = meta.maxWidth ?? Number.POSITIVE_INFINITY;
	const maxH = meta.maxHeight ?? Number.POSITIVE_INFINITY;
	const maxArea = meta.maxArea ?? Number.POSITIVE_INFINITY;
	// Everything advertised has to be something the server will actually serve.
	// The height follows the width through the same arithmetic resolveSize uses,
	// so a client requesting an advertised width gets back the pair listed here,
	// and anything a configured ceiling would reject is left out.
	const sizes = o.scaleFactors
		.slice()
		.sort((a, b) => b - a)
		.map((f) => {
			const width = Math.max(1, Math.floor(meta.width / f));
			return { width, height: Math.max(1, Math.round((meta.height / meta.width) * width)) };
		})
		.filter((s) => s.width <= maxW && s.height <= maxH && s.width * s.height <= maxArea);
	// Section 5.2 requires advertised tiles to sit inside the limits too, so the
	// tile shrinks rather than naming a size the server would reject.
	const tile = Math.max(1, Math.min(tileSize, maxW, maxH, Math.floor(Math.sqrt(maxArea))));
	const doc: Record<string, unknown> = {
		"@context": "http://iiif.io/api/image/3/context.json",
		id: o.id,
		type: "ImageService3",
		protocol: "http://iiif.io/api/image",
		profile: "level2",
		width: meta.width,
		height: meta.height,
		maxWidth: meta.maxWidth,
		maxHeight: meta.maxHeight,
		maxArea: meta.maxArea,
		sizes,
		tiles: [
			{
				width: tile,
				height: tile,
				scaleFactors: o.scaleFactors.slice().sort((a, b) => a - b),
			},
		],
		preferredFormats: ["jpg"],
		extraQualities: ["color", "gray", "bitonal"],
		extraFormats: ["webp"],
		extraFeatures: [
			"baseUriRedirect",
			"canonicalLinkHeader",
			"cors",
			"jsonldMediaType",
			"mirroring",
			"profileLinkHeader",
			"regionByPct",
			"regionByPx",
			"regionSquare",
			"rotationArbitrary",
			"rotationBy90s",
			"sizeByConfinedWh",
			"sizeByH",
			"sizeByPct",
			"sizeByW",
			"sizeByWh",
			"sizeUpscaling",
		],
	};
	if (o.rights) doc.rights = o.rights;
	if (o.partOf?.length) doc.partOf = o.partOf;
	for (const k of ["maxWidth", "maxHeight", "maxArea"]) if (doc[k] === undefined) delete doc[k];
	return doc;
}
