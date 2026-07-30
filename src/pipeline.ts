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

/** Opaque white, for formats that cannot carry the corners rotation leaves empty. */
export const WHITE: Pixel = [255, 255, 255, 255];
/** Transparent, for formats that can. */
export const CLEAR: Pixel = [0, 0, 0, 0];

export type Pixel = [number, number, number, number];

/**
 * Rotate clockwise about the centre onto a canvas large enough to hold the
 * result, filling the corners the source does not cover.
 *
 * photon's own `rotate` is not usable: in @cf-wasm/photon 0.3.7 it returns a
 * buffer in which nearly every pixel is wrong at every angle (a 60×40 solid
 * fill comes back with 2399 of 2400 pixels altered), and the canvas it returns
 * is far larger than the rotated content needs. Rotation therefore runs here on
 * the raw RGBA bytes.
 */
export function rotated(img: PhotonImage, degrees: number, bg: Pixel): PhotonImage {
	const w = img.get_width();
	const h = img.get_height();
	const src = img.get_raw_pixels();

	// Right angles are an exact reindexing, with no resampling to blur text.
	if (degrees === 90 || degrees === 180 || degrees === 270) {
		const quarter = degrees / 90;
		const dw = quarter === 2 ? w : h;
		const dh = quarter === 2 ? h : w;
		const dst = new Uint8Array(dw * dh * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const dx = quarter === 1 ? h - 1 - y : quarter === 2 ? w - 1 - x : y;
				const dy = quarter === 1 ? x : quarter === 2 ? h - 1 - y : w - 1 - x;
				const si = (y * w + x) * 4;
				const di = (dy * dw + dx) * 4;
				dst[di] = src[si] as number;
				dst[di + 1] = src[si + 1] as number;
				dst[di + 2] = src[si + 2] as number;
				dst[di + 3] = src[si + 3] as number;
			}
		}
		return new PhotonImage(dst, dw, dh);
	}

	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dw = Math.max(1, Math.round(Math.abs(w * cos) + Math.abs(h * sin)));
	const dh = Math.max(1, Math.round(Math.abs(w * sin) + Math.abs(h * cos)));
	const dst = new Uint8Array(dw * dh * 4);
	const cxS = w / 2;
	const cyS = h / 2;
	const cxD = dw / 2;
	const cyD = dh / 2;
	for (let dy = 0; dy < dh; dy++) {
		for (let dx = 0; dx < dw; dx++) {
			const ox = dx + 0.5 - cxD;
			const oy = dy + 0.5 - cyD;
			const sx = ox * cos + oy * sin + cxS;
			const sy = -ox * sin + oy * cos + cyS;
			const di = (dy * dw + dx) * 4;
			if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
				dst[di] = bg[0];
				dst[di + 1] = bg[1];
				dst[di + 2] = bg[2];
				dst[di + 3] = bg[3];
				continue;
			}
			// Bilinear, so an arbitrary angle does not shred the letterforms.
			const fx = sx - 0.5;
			const fy = sy - 0.5;
			const x0 = Math.floor(fx);
			const y0 = Math.floor(fy);
			const tx = fx - x0;
			const ty = fy - y0;
			const xa = Math.min(w - 1, Math.max(0, x0));
			const ya = Math.min(h - 1, Math.max(0, y0));
			const xb = Math.min(w - 1, Math.max(0, x0 + 1));
			const yb = Math.min(h - 1, Math.max(0, y0 + 1));
			const p00 = (ya * w + xa) * 4;
			const p10 = (ya * w + xb) * 4;
			const p01 = (yb * w + xa) * 4;
			const p11 = (yb * w + xb) * 4;
			for (let ch = 0; ch < 4; ch++) {
				const top = (src[p00 + ch] as number) * (1 - tx) + (src[p10 + ch] as number) * tx;
				const bot = (src[p01 + ch] as number) * (1 - tx) + (src[p11 + ch] as number) * tx;
				dst[di + ch] = Math.round(top * (1 - ty) + bot * ty);
			}
		}
	}
	return new PhotonImage(dst, dw, dh);
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
		if (resolved.rotation.degrees !== 0)
			// JPEG carries no alpha, so its uncovered corners have to be painted.
			release(rotated(work, resolved.rotation.degrees, resolved.format === "jpg" ? WHITE : CLEAR));
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
