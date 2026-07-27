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
	let chosen = 1;
	for (const f of [...stored.levels].sort((a, b) => b - a)) {
		if (rect.w / f >= outW && rect.h / f >= outH) {
			chosen = f;
			break;
		}
	}
	const scaled = {
		x: Math.floor(rect.x / chosen),
		y: Math.floor(rect.y / chosen),
		w: Math.max(1, Math.round(rect.w / chosen)),
		h: Math.max(1, Math.round(rect.h / chosen)),
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
	try {
		const lw = img.get_width();
		const lh = img.get_height();
		// Clamp the level rect defensively against rounding at edges.
		const x = Math.min(choice.rect.x, lw - 1);
		const y = Math.min(choice.rect.y, lh - 1);
		const w = Math.min(choice.rect.w, lw - x);
		const h = Math.min(choice.rect.h, lh - y);
		if (w <= 0 || h <= 0) throw new IIIFError(400, "region has no pixels");

		let work = crop(img, x, y, x + w, y + h);
		if (work.get_width() !== resolved.outW || work.get_height() !== resolved.outH) {
			const resized = resize(work, resolved.outW, resolved.outH, SamplingFilter.Lanczos3);
			work.free();
			work = resized;
		}
		if (resolved.rotation.mirror) fliph(work);
		const deg = resolved.rotation.degrees;
		if (deg !== 0) {
			const rotated = rotate(work, deg);
			work.free();
			work = rotated;
		}
		if (resolved.quality === "gray") grayscale(work);
		else if (resolved.quality === "bitonal") {
			grayscale(work);
			threshold(work, 128);
		}

		let bytes: Uint8Array;
		let contentType: string;
		switch (resolved.format) {
			case "png":
				bytes = work.get_bytes();
				contentType = "image/png";
				break;
			case "webp":
				bytes = work.get_bytes_webp();
				contentType = "image/webp";
				break;
			default:
				bytes = work.get_bytes_jpeg(85);
				contentType = "image/jpeg";
				break;
		}
		work.free();
		return { bytes, contentType };
	} finally {
		// img may already be consumed by crop; PhotonImage.free is idempotent-safe
		// only when not consumed — crop() takes &img so the original must be freed.
		try {
			img.free();
		} catch {
			/* already freed */
		}
	}
}
