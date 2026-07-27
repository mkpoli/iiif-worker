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
	const sizes = o.scaleFactors
		.slice()
		.sort((a, b) => b - a)
		.map((f) => ({
			width: Math.floor(meta.width / f),
			height: Math.floor(meta.height / f),
		}));
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
				width: tileSize,
				height: tileSize,
				scaleFactors: o.scaleFactors.slice().sort((a, b) => a - b),
			},
		],
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
