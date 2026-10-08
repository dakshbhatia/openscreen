import { describe, expect, it } from "vitest";
import { zoomTransitionMs } from "../../zoomMath/constants";
import { type SpeedRegion, screenTimeMs, timelineTimeMs } from "./speed";
import { chainedPans, transitionCutsMs, zoomTransitions } from "./zoom-transitions";

const W = zoomTransitionMs(1.8); // ≈ 923 ms
const zoom = { startMs: 10_000, endMs: 12_000, scale: 1.8 };

describe("timelineTimeMs", () => {
	it("inverts screenTimeMs, overlapping regions included", () => {
		const regions: SpeedRegion[] = [
			{ id: "a", startMs: 2000, endMs: 6000, speed: 2 },
			{ id: "b", startMs: 4000, endMs: 9000, speed: 4 },
			{ id: "c", startMs: 12_000, endMs: 13_000, speed: 0.5 },
		];
		for (const t of [0, 1999, 2000, 3000, 6000, 7500, 9000, 12_500, 20_000]) {
			expect(timelineTimeMs(regions, screenTimeMs(regions, t))).toBeCloseTo(t, 6);
		}
	});
});

describe("zoomTransitions", () => {
	it("puts the moves just outside the pill, deeper zooms longer", () => {
		const t = zoomTransitions(zoom, []);
		expect(t.inFromMs).toBeCloseTo(10_000 - W, 6);
		expect(t.outUntilMs).toBeCloseTo(12_000 + W, 6);
		expect(zoomTransitions({ ...zoom, scale: 5 }, []).durationMs).toBeGreaterThan(t.durationMs);
	});

	it("stretches a move across the timeline inside a speed region (issue #1028 variant)", () => {
		const t = zoomTransitions(zoom, [{ id: "s", startMs: 12_000, endMs: 20_000, speed: 3 }]);
		expect(t.outUntilMs).toBeCloseTo(12_000 + 3 * W, 6);
		expect(t.inFromMs).toBeCloseTo(10_000 - W, 6);
	});

	it("never starts a zoom-in before the timeline", () => {
		expect(zoomTransitions({ startMs: 300, endMs: 2000, scale: 1.8 }, []).inFromMs).toBe(0);
	});
});

describe("transitionCutsMs", () => {
	const t = zoomTransitions(zoom, []);

	it("reports the whole zoom-out lost to a trim starting at the pill's end (issue #1028)", () => {
		const cut = transitionCutsMs(zoom, t, [{ startMs: 12_000, endMs: 14_000 }]);
		expect(cut.inMs).toBe(0);
		expect(cut.outMs).toBeCloseTo(W, 6);
	});

	it("measures a partial cut from the first trimmed instant", () => {
		expect(transitionCutsMs(zoom, t, [{ startMs: 12_500, endMs: 13_000 }]).outMs).toBeCloseTo(
			12_000 + W - 12_500,
			6,
		);
		expect(transitionCutsMs(zoom, t, [{ startMs: 9000, endMs: 9500 }]).inMs).toBeCloseTo(
			9500 - (10_000 - W),
			6,
		);
	});

	it("ignores trims clear of the windows, inside the pill, or swallowing the whole zoom", () => {
		const none = { inMs: 0, outMs: 0, inByJunction: false, outByJunction: false };
		expect(transitionCutsMs(zoom, t, [{ startMs: 13_000, endMs: 14_000 }])).toEqual(none);
		expect(transitionCutsMs(zoom, t, [{ startMs: 10_500, endMs: 11_000 }])).toEqual(none);
		expect(transitionCutsMs(zoom, t, [{ startMs: 9000, endMs: 14_000 }])).toEqual(none);
	});

	it("loses the whole move to a cut touching the pill's edge, the segment it ends", () => {
		expect(transitionCutsMs(zoom, t, [{ startMs: 11_000, endMs: 12_000 }]).outMs).toBeCloseTo(W, 6);
		expect(transitionCutsMs(zoom, t, [{ startMs: 10_000, endMs: 11_000 }]).inMs).toBeCloseTo(W, 6);
	});

	it("counts a clip junction as a zero-length cut, and says so (issue #1028)", () => {
		const at = (ms: number) => [{ startMs: ms, endMs: ms }];
		expect(transitionCutsMs(zoom, t, [], at(12_500))).toEqual({
			inMs: 0,
			outMs: expect.closeTo(12_000 + W - 12_500, 6),
			inByJunction: false,
			outByJunction: true,
		});
		expect(transitionCutsMs(zoom, t, [], at(9500))).toMatchObject({
			inMs: expect.closeTo(9500 - (10_000 - W), 6),
			inByJunction: true,
		});
		expect(transitionCutsMs(zoom, t, [], at(12_000)).outMs).toBeCloseTo(W, 6);
		expect(transitionCutsMs(zoom, t, [], at(10_000)).inMs).toBeCloseTo(W, 6);
		const none = { inMs: 0, outMs: 0, inByJunction: false, outByJunction: false };
		expect(transitionCutsMs(zoom, t, [], at(12_000 + W))).toEqual(none);
		expect(transitionCutsMs(zoom, t, [], at(10_000 - W))).toEqual(none);
	});

	it("blames the cut nearest the pill, where the export jumps", () => {
		const trim = [{ startMs: 12_600, endMs: 13_500 }];
		const junction = (ms: number) => [{ startMs: ms, endMs: ms }];
		expect(transitionCutsMs(zoom, t, trim, junction(12_300))).toMatchObject({
			outMs: expect.closeTo(12_000 + W - 12_300, 6),
			outByJunction: true,
		});
		expect(transitionCutsMs(zoom, t, trim, junction(12_800))).toMatchObject({
			outMs: expect.closeTo(12_000 + W - 12_600, 6),
			outByJunction: false,
		});
	});
});

describe("chainedPans", () => {
	const next = { startMs: 13_000, endMs: 15_000 };

	it("pans for 1 s from the first zoom's end when the next starts within 1.5 s", () => {
		expect(chainedPans([next, zoom], [], [])).toEqual([{ from: 1, to: 0, untilMs: 13_000 }]);
		expect(chainedPans([zoom, { startMs: 13_600, endMs: 15_000 }], [], [])).toEqual([]);
	});

	it("measures the gap and the pan on screen time", () => {
		const fast = [{ id: "s", startMs: 12_000, endMs: 20_000, speed: 3 }];
		// 3 s of timeline at 3× is 1 s on screen: chained, and the pan covers 3 s of timeline.
		expect(chainedPans([zoom, { startMs: 15_000, endMs: 16_000 }], fast, [])).toEqual([
			{ from: 0, to: 1, untilMs: 15_000 },
		]);
	});

	it("is broken by a trim or a clip junction between the zooms, not by one inside them", () => {
		expect(chainedPans([zoom, next], [], [{ startMs: 12_200, endMs: 12_400 }])).toEqual([]);
		expect(chainedPans([zoom, next], [], [{ startMs: 12_000, endMs: 12_000 }])).toEqual([]);
		expect(chainedPans([zoom, next], [], [{ startMs: 13_000, endMs: 13_000 }])).toEqual([]);
		expect(chainedPans([zoom, next], [], [{ startMs: 10_500, endMs: 11_000 }])).toHaveLength(1);
	});

	it("skips a zoom entirely under a trim, which the compositor never chains", () => {
		const hidden = { startMs: 11_000, endMs: 11_500 };
		expect(chainedPans([zoom, hidden, next], [], [hidden])).toEqual([
			{ from: 0, to: 2, untilMs: 13_000 },
		]);
	});
});
