import { describe, expect, test } from "bun:test";
import { chooseLevel, type StoredMeta } from "../src/pipeline";

const stored: StoredMeta = { width: 2155, height: 3452, levels: [1, 2, 4, 8], format: "jpeg" };

function resolved(
	rect: { x: number; y: number; w: number; h: number },
	outW: number,
	outH: number,
) {
	return {
		rect,
		outW,
		outH,
		sizeIsMax: false,
		rotation: { mirror: false, degrees: 0 },
		quality: "default" as const,
		format: "jpg" as const,
	};
}

describe("pyramid level choice", () => {
	test("a full-size request reads the master", () =>
		expect(chooseLevel(resolved({ x: 0, y: 0, w: 2155, h: 3452 }, 2155, 3452), stored).key).toBe(
			"L1",
		));
	test("an eighth-size request reads L8", () =>
		expect(chooseLevel(resolved({ x: 0, y: 0, w: 2155, h: 3452 }, 269, 431), stored).key).toBe(
			"L8",
		));
	test("a detail crop still reads the master", () =>
		expect(chooseLevel(resolved({ x: 300, y: 400, w: 700, h: 500 }, 700, 500), stored).key).toBe(
			"L1",
		));
	test("the level rect keeps both edges, not just the origin", () => {
		// x=301 on L2 rounds to 150 (not floor 150 from a shifted origin) and the
		// width follows the far edge, so the rectangle does not creep top-left.
		const choice = chooseLevel(resolved({ x: 301, y: 401, w: 700, h: 500 }, 350, 250), stored);
		expect(choice.factor).toBe(2);
		expect(choice.rect).toEqual({ x: 151, y: 201, w: 350, h: 250 });
	});
	test("meta without a level 1 is rejected", () =>
		expect(() =>
			chooseLevel(resolved({ x: 0, y: 0, w: 100, h: 100 }, 100, 100), {
				...stored,
				levels: [2, 4],
			}),
		).toThrow());
});
