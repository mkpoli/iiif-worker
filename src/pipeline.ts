/**
 * Image pipeline: choose the smallest stored pyramid level that can serve the
 * request, fetch it from R2, then crop → resize → rotate → quality → encode
 * with photon (wasm).
 */

import {
	crop,
	fliph,
	grayscale,
	PhotonImage,
	resize,
	rotate,
	SamplingFilter,
	threshold,
} from "@cf-wasm/photon";
import { IIIFError, type ResolvedRequest } from "./params";

export interface StoredMeta {
	width: number;
	height: number;
	/** Scale denominators of stored levels, ascending, always including 1. */
	levels: number[];
	/** Content type of stored level files. */
	format: "jpeg" | "png" | "webp";
}

export interface LevelChoice {
	/** Chosen scale denominator. */
	factor: number;
	/** Key suffix, e.g. "L2". */
	key: string;
	/** Source rect mapped onto the chosen level. */
	rect: { x: number; y: number; w: number; h: number };
}

/**
 * Pick the smallest stored level whose resolution still covers the requested
 * output, so decode cost tracks output size rather than master size.
 */
export function chooseLevel(resolved: ResolvedRequest, stored: StoredMeta): LevelChoice {
	const { rect, outW, outH } = resolved;
	if (!stored.levels.includes(1))
		throw new IIIFError(500, "stored meta lists no level 1; the prefix needs re-ingesting");
	let chosen = 1;
	for (const f of [...stored.levels].sort((a, b) => b - a)) {
		if (rect.w / f >= outW && rect.h / f >= outH) {
			chosen = f;
			break;
		}
	}
	// Both edges are rounded to the nearest level pixel rather than flooring the
	// origin, which would drag the whole rectangle up to a full level pixel
	// towards the top-left at every zoom step.
	const x = Math.round(rect.x / chosen);
	const y = Math.round(rect.y / chosen);
	const scaled = {
		x,
		y,
		w: Math.max(1, Math.round((rect.x + rect.w) / chosen) - x),
		h: Math.max(1, Math.round((rect.y + rect.h) / chosen) - y),
	};
	return { factor: chosen, key: `L${chosen}`, rect: scaled };
}

export interface EncodeResult {
	bytes: Uint8Array;
	contentType: string;
}

/** Run the full transform on decoded level bytes. */
export function transform(
	levelBytes: Uint8Array,
	choice: LevelChoice,
	resolved: ResolvedRequest,
): EncodeResult {
	const img = PhotonImage.new_from_byteslice(levelBytes);
	/** Every intermediate, freed on the way out however this returns. */
	let work = img;
	const release = (next: PhotonImage) => {
		if (work !== img) work.free();
		work = next;
	};
	try {
		const lw = img.get_width();
		const lh = img.get_height();
		// Clamp the level rect defensively against rounding at edges.
		const x = Math.min(choice.rect.x, lw - 1);
		const y = Math.min(choice.rect.y, lh - 1);
		const w = Math.min(choice.rect.w, lw - x);
		const h = Math.min(choice.rect.h, lh - y);
		if (w <= 0 || h <= 0) throw new IIIFError(400, "region has no pixels");

		// A whole-level region needs no crop, and skipping it avoids holding a
		// second full-size decode — the peak that decides how large a master the
		// isolate can serve at all.
		if (x !== 0 || y !== 0 || w !== lw || h !== lh) release(crop(img, x, y, x + w, y + h));
		if (work.get_width() !== resolved.outW || work.get_height() !== resolved.outH)
			release(resize(work, resolved.outW, resolved.outH, SamplingFilter.Lanczos3));
		if (resolved.rotation.mirror) fliph(work);
		if (resolved.rotation.degrees !== 0) release(rotate(work, resolved.rotation.degrees));
		if (resolved.quality === "gray") grayscale(work);
		else if (resolved.quality === "bitonal") {
			grayscale(work);
			threshold(work, 128);
		}

		switch (resolved.format) {
			case "png":
				return { bytes: work.get_bytes(), contentType: "image/png" };
			case "webp":
				return { bytes: work.get_bytes_webp(), contentType: "image/webp" };
			default:
				return { bytes: work.get_bytes_jpeg(85), contentType: "image/jpeg" };
		}
	} finally {
		if (work !== img) work.free();
		img.free();
	}
}
