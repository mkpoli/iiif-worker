import { describe, expect, test } from "bun:test";
import {
	canonicalPath,
	IIIFError,
	type ImageMeta,
	maxDimensions,
	parseIIIFPath,
	parseQualityFormat,
	parseRegion,
	parseRotation,
	parseSize,
	resolve,
	resolveRegion,
	resolveSize,
} from "../src/params";

const meta: ImageMeta = { width: 2155, height: 3452 };
const small: ImageMeta = { width: 300, height: 200 };

describe("region parsing", () => {
	test("full", () => expect(parseRegion("full")).toEqual({ kind: "full" }));
	test("square", () => expect(parseRegion("square")).toEqual({ kind: "square" }));
	test("pixels", () =>
		expect(parseRegion("125,15,120,140")).toEqual({
			kind: "pixels",
			x: 125,
			y: 15,
			w: 120,
			h: 140,
		}));
	test("percent", () =>
		expect(parseRegion("pct:41.6,7.5,40,70")).toEqual({
			kind: "pct",
			x: 41.6,
			y: 7.5,
			w: 40,
			h: 70,
		}));
	test.each(["fulll", "1,2,3", "1,2,3,4,5", "a,b,c,d", "-1,0,10,10", "pct:x,0,1,1"])(
		"malformed %s → 400",
		(s) => expect(() => parseRegion(s)).toThrow(IIIFError),
	);
	test("zero-width pixels → 400", () => expect(() => parseRegion("0,0,0,10")).toThrow(IIIFError));
	test("pct x=100 → 400", () => expect(() => parseRegion("pct:100,0,10,10")).toThrow(IIIFError));
});

describe("size parsing", () => {
	test("max", () => expect(parseSize("max")).toEqual({ kind: "max", upscale: false }));
	test("^max", () => expect(parseSize("^max")).toEqual({ kind: "max", upscale: true }));
	test("w,", () => expect(parseSize("150,")).toEqual({ kind: "w", upscale: false, w: 150 }));
	test("^w,", () => expect(parseSize("^360,")).toEqual({ kind: "w", upscale: true, w: 360 }));
	test(",h", () => expect(parseSize(",150")).toEqual({ kind: "h", upscale: false, h: 150 }));
	test("pct:n", () => expect(parseSize("pct:50")).toEqual({ kind: "pct", upscale: false, n: 50 }));
	test("^pct:120", () =>
		expect(parseSize("^pct:120")).toEqual({
			kind: "pct",
			upscale: true,
			n: 120,
		}));
	test("w,h", () =>
		expect(parseSize("225,100")).toEqual({
			kind: "wh",
			upscale: false,
			w: 225,
			h: 100,
		}));
	test("!w,h", () =>
		expect(parseSize("!225,100")).toEqual({
			kind: "confined",
			upscale: false,
			w: 225,
			h: 100,
		}));
	test.each(["", ",", "^", "pct:0", "pct:120", "0,", ",0", "a,b", "!,100", "1,2,3"])(
		"malformed %s → 400",
		(s) => expect(() => parseSize(s)).toThrow(IIIFError),
	);
});

describe("rotation parsing", () => {
	test("0", () => expect(parseRotation("0")).toEqual({ mirror: false, degrees: 0 }));
	test("90", () => expect(parseRotation("90")).toEqual({ mirror: false, degrees: 90 }));
	test("!0", () => expect(parseRotation("!0")).toEqual({ mirror: true, degrees: 0 }));
	test("22.5", () => expect(parseRotation("22.5")).toEqual({ mirror: false, degrees: 22.5 }));
	test("360 → 0", () => expect(parseRotation("360")).toEqual({ mirror: false, degrees: 0 }));
	test.each(["-90", "361", "!!90", "x"])("malformed %s → 400", (s) =>
		expect(() => parseRotation(s)).toThrow(IIIFError),
	);
});

describe("quality/format parsing", () => {
	test.each(["default", "color", "gray", "bitonal"] as const)("%s.jpg", (q) =>
		expect(parseQualityFormat(`${q}.jpg`)).toEqual({
			quality: q,
			format: "jpg",
		}),
	);
	test.each(["png", "webp"] as const)("default.%s", (f) =>
		expect(parseQualityFormat(`default.${f}`)).toEqual({
			quality: "default",
			format: f,
		}),
	);
	test.each(["default", "default.tif", "default.gif", "native.jpg", "grey.jpg"])(
		"unsupported %s → 400",
		(s) => expect(() => parseQualityFormat(s)).toThrow(IIIFError),
	);
});

describe("region resolution", () => {
	test("full", () =>
		expect(resolveRegion({ kind: "full" }, meta)).toEqual({
			x: 0,
			y: 0,
			w: 2155,
			h: 3452,
		}));
	test("square centers on shorter axis", () =>
		expect(resolveRegion({ kind: "square" }, meta)).toEqual({
			x: 0,
			y: 648,
			w: 2155,
			h: 2155,
		}));
	test("pixels clip to bounds", () =>
		expect(resolveRegion({ kind: "pixels", x: 2000, y: 3400, w: 500, h: 500 }, meta)).toEqual({
			x: 2000,
			y: 3400,
			w: 155,
			h: 52,
		}));
	test("pct resolves against dimensions", () =>
		expect(resolveRegion({ kind: "pct", x: 50, y: 50, w: 50, h: 50 }, small)).toEqual({
			x: 150,
			y: 100,
			w: 150,
			h: 100,
		}));
	test("region past edge → 400", () =>
		expect(() => resolveRegion({ kind: "pixels", x: 2155, y: 0, w: 10, h: 10 }, meta)).toThrow(
			IIIFError,
		));
});

describe("size resolution", () => {
	const rect = { x: 0, y: 0, w: 300, h: 200 };
	test("max keeps region size", () =>
		expect(resolveSize({ kind: "max", upscale: false }, rect, small)).toEqual({
			outW: 300,
			outH: 200,
		}));
	test("max respects maxWidth", () =>
		expect(
			resolveSize({ kind: "max", upscale: false }, rect, {
				...small,
				maxWidth: 150,
			}),
		).toEqual({ outW: 150, outH: 100 }));
	test("w scales height", () =>
		expect(resolveSize({ kind: "w", upscale: false, w: 150 }, rect, small)).toEqual({
			outW: 150,
			outH: 100,
		}));
	test("h scales width", () =>
		expect(resolveSize({ kind: "h", upscale: false, h: 100 }, rect, small)).toEqual({
			outW: 150,
			outH: 100,
		}));
	test("pct:50", () =>
		expect(resolveSize({ kind: "pct", upscale: false, n: 50 }, rect, small)).toEqual({
			outW: 150,
			outH: 100,
		}));
	test("wh distorts freely", () =>
		expect(resolveSize({ kind: "wh", upscale: false, w: 225, h: 100 }, rect, small)).toEqual({
			outW: 225,
			outH: 100,
		}));
	test("confined preserves aspect", () =>
		expect(resolveSize({ kind: "confined", upscale: false, w: 225, h: 100 }, rect, small)).toEqual({
			outW: 150,
			outH: 100,
		}));
	test("upscale without ^ → 400", () =>
		expect(() => resolveSize({ kind: "w", upscale: false, w: 600 }, rect, small)).toThrow(
			IIIFError,
		));
	test("upscale with ^ works", () =>
		expect(resolveSize({ kind: "w", upscale: true, w: 600 }, rect, small)).toEqual({
			outW: 600,
			outH: 400,
		}));
	test("^max with no limits keeps the region", () =>
		expect(resolveSize({ kind: "max", upscale: true }, rect, small)).toEqual({
			outW: 300,
			outH: 200,
		}));
	test("^max scales up to maxWidth", () =>
		expect(resolveSize({ kind: "max", upscale: true }, rect, { ...small, maxWidth: 900 })).toEqual({
			outW: 900,
			outH: 600,
		}));
	test("^max scales up to maxArea", () =>
		expect(
			resolveSize({ kind: "max", upscale: true }, rect, { ...small, maxArea: 240_000 }),
		).toEqual({ outW: 600, outH: 400 }));
	test("confined box larger than region fits the region", () =>
		expect(resolveSize({ kind: "confined", upscale: false, w: 600, h: 600 }, rect, small)).toEqual({
			outW: 300,
			outH: 200,
		}));
	test("^confined box larger than region upscales", () =>
		expect(resolveSize({ kind: "confined", upscale: true, w: 600, h: 600 }, rect, small)).toEqual({
			outW: 600,
			outH: 400,
		}));
	test("confined never exceeds server limits", () =>
		expect(
			resolveSize({ kind: "confined", upscale: true, w: 6000, h: 6000 }, rect, {
				...small,
				maxWidth: 450,
			}),
		).toEqual({ outW: 450, outH: 300 }));
	test("size rounding below one pixel → 400", () =>
		expect(() => resolveSize({ kind: "pct", upscale: false, n: 0.1 }, rect, small)).toThrow(
			IIIFError,
		));
	test("^ but over server max → 400", () =>
		expect(() =>
			resolveSize({ kind: "w", upscale: true, w: 600 }, rect, {
				...small,
				maxWidth: 500,
			}),
		).toThrow(IIIFError));
});

describe("max dimensions", () => {
	const rect = { x: 0, y: 0, w: 300, h: 200 };
	test("unbounded max is the region", () =>
		expect(maxDimensions(rect, small, false)).toEqual({ outW: 300, outH: 200 }));
	test("unbounded ^max is the region", () =>
		expect(maxDimensions(rect, small, true)).toEqual({ outW: 300, outH: 200 }));
	test("^max fills maxWidth", () =>
		expect(maxDimensions(rect, { ...small, maxWidth: 1200 }, true)).toEqual({
			outW: 1200,
			outH: 800,
		}));
	test("max shrinks to maxHeight", () =>
		expect(maxDimensions(rect, { ...small, maxHeight: 100 }, false)).toEqual({
			outW: 150,
			outH: 100,
		}));
});

describe("canonical path", () => {
	test("full/max/0/default.jpg stays", () => {
		const req = parseIIIFPath("full", "max", "0", "default.jpg");
		const r = resolve(req, meta);
		expect(canonicalPath(r, meta)).toBe("full/max/0/default.jpg");
	});
	test("pct region canonicalizes to pixels", () => {
		const req = parseIIIFPath("pct:0,0,50,50", "max", "0", "default.jpg");
		const r = resolve(req, meta);
		expect(canonicalPath(r, meta)).toBe("0,0,1078,1726/max/0/default.jpg");
	});
	test("w, canonicalizes to w,h", () => {
		const req = parseIIIFPath("full", "431,", "0", "default.jpg");
		const r = resolve(req, meta);
		expect(canonicalPath(r, meta)).toBe("full/431,690/0/default.jpg");
	});
	test("mirror + arbitrary rotation preserved", () => {
		const req = parseIIIFPath("square", "!400,400", "!22.5", "gray.png");
		const r = resolve(req, meta);
		expect(canonicalPath(r, meta)).toBe("0,648,2155,2155/400,400/!22.5/gray.png");
	});
});
