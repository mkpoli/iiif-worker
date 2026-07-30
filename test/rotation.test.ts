import { describe, expect, test } from "bun:test";
import { PhotonImage } from "@cf-wasm/photon";
import { CLEAR, type Pixel, rotated, WHITE } from "../src/pipeline";

/** A solid RGBA image, so any pixel that changes value is a transform bug. */
function solid(w: number, h: number, px: Pixel): PhotonImage {
	const buf = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) buf.set(px, i * 4);
	return new PhotonImage(buf, w, h);
}

function at(img: PhotonImage, x: number, y: number): number[] {
	const i = (y * img.get_width() + x) * 4;
	return Array.from(img.get_raw_pixels().slice(i, i + 4));
}

describe("rotation", () => {
	const BLUE: Pixel = [10, 90, 200, 255];

	test.each([90, 180, 270])("%s° preserves every pixel", (deg) => {
		const out = rotated(solid(60, 40, BLUE), deg, WHITE);
		const px = out.get_raw_pixels();
		let wrong = 0;
		for (let i = 0; i < out.get_width() * out.get_height(); i++)
			if (
				px[i * 4] !== 10 ||
				px[i * 4 + 1] !== 90 ||
				px[i * 4 + 2] !== 200 ||
				px[i * 4 + 3] !== 255
			)
				wrong += 1;
		expect(wrong).toBe(0);
	});

	test.each([
		[90, 40, 60],
		[180, 60, 40],
		[270, 40, 60],
	])("%s° swaps the axes as expected", (deg, w, h) => {
		const out = rotated(solid(60, 40, BLUE), deg as number, WHITE);
		expect([out.get_width(), out.get_height()]).toEqual([w, h]);
	});

	test("90° turns clockwise", () => {
		// Mark the source top-left; after a clockwise quarter turn it is top-right.
		const img = solid(4, 2, BLUE);
		const px = img.get_raw_pixels();
		px.set([255, 0, 0, 255], 0);
		const marked = new PhotonImage(px, 4, 2);
		const out = rotated(marked, 90, WHITE);
		expect(at(out, out.get_width() - 1, 0)).toEqual([255, 0, 0, 255]);
	});

	test("an arbitrary angle grows the canvas to fit", () => {
		const out = rotated(solid(60, 40, BLUE), 45, WHITE);
		expect(out.get_width()).toBeGreaterThan(60);
		expect(out.get_height()).toBeGreaterThan(40);
	});

	test("uncovered corners take the background", () => {
		expect(at(rotated(solid(60, 40, BLUE), 45, WHITE), 1, 1)).toEqual([255, 255, 255, 255]);
		expect(at(rotated(solid(60, 40, BLUE), 45, CLEAR), 1, 1)).toEqual([0, 0, 0, 0]);
	});

	test("the interior survives an arbitrary angle", () => {
		const out = rotated(solid(60, 40, BLUE), 45, WHITE);
		expect(at(out, out.get_width() >> 1, out.get_height() >> 1)).toEqual([10, 90, 200, 255]);
	});
});
