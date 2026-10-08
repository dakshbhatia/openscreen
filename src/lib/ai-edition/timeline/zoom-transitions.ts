// Where a zoom's camera moves sit on the timeline (#1028). A zoom pill shows the HOLD: the
// zoom-in runs entirely before its start and the zoom-out entirely after its end, each
// lasting `zoomTransitionMs(scale)` of SCREEN time (`computeRegionStrength`, mirror of
// `zoom_region_strength` in crates/compositor/src/regions.rs). These helpers turn those
// windows into timeline ms, through the same speed-aware clock, and measure what a trim or a
// clip junction cuts off them: the render drops the trimmed frames and renders each clip on
// its own, so the camera jumps at the cut instead of easing.
//
// Chained zooms (closer than 1.5 s on screen) have no zoom-out and zoom-in between them: the
// camera pans from one to the other instead (`chainedPans`). A trim or a junction between two
// zooms splits them into separate segments, which breaks the chain, so each then has its own
// windows.

import {
	CHAINED_ZOOM_PAN_GAP_MS,
	CONNECTED_ZOOM_PAN_DURATION_MS,
	zoomTransitionMs,
} from "../../zoomMath/constants";
import { type SpeedRegion, screenTimeMs, timelineTimeMs } from "./speed";
import { ZOOM_DEPTH_SCALES } from "./zoom-scale";

export interface Span {
	startMs: number;
	endMs: number;
}

export interface ZoomTransitions {
	/** Timeline ms where the zoom-in starts. It lands on the zoom's start. */
	inFromMs: number;
	/** Timeline ms where the zoom-out, which leaves from the zoom's end, is over. */
	outUntilMs: number;
	/** Screen ms each move lasts, whatever the speed regions do to the footage. */
	durationMs: number;
}

/** "0.72 s at 1.25×, …": every depth's move duration, for the agent's tool descriptions. */
export const ZOOM_TRANSITION_LEGEND = Object.values(ZOOM_DEPTH_SCALES)
	.sort((a, b) => a - b)
	.map((scale) => `${(zoomTransitionMs(scale) / 1000).toFixed(2)} s at ${scale.toFixed(2)}×`)
	.join(", ");

export function zoomTransitions(
	zoom: Span & { scale: number },
	speedRegions: readonly SpeedRegion[],
): ZoomTransitions {
	const durationMs = zoomTransitionMs(zoom.scale);
	return {
		inFromMs: Math.max(
			0,
			timelineTimeMs(speedRegions, screenTimeMs(speedRegions, zoom.startMs) - durationMs),
		),
		outUntilMs: timelineTimeMs(speedRegions, screenTimeMs(speedRegions, zoom.endMs) + durationMs),
		durationMs,
	};
}

/**
 * Timeline ms of each move the cuts take off (0 when untouched), and whether a clip junction
 * rather than a trim is the cut that does it. The compositor renders each clip segment on its
 * own and gives a zoom only to the segments it overlaps, so the zoom-in only plays after the
 * last cut before the zoom and the zoom-out only until the first one after it, a cut touching
 * the pill's edge included. A junction is a zero-length cut. A zoom entirely under a trim
 * never plays and the compositor renders it without envelopes (`under_trim`), so it has
 * nothing to cut.
 */
export function transitionCutsMs(
	zoom: Span,
	transitions: ZoomTransitions,
	trims: readonly Span[],
	junctions: readonly Span[] = [],
): { inMs: number; outMs: number; inByJunction: boolean; outByJunction: boolean } {
	let resumesAt = transitions.inFromMs;
	let jumpsAt = transitions.outUntilMs;
	let inByJunction = false;
	let outByJunction = false;
	if (!trims.some((t) => t.startMs <= zoom.startMs && t.endMs >= zoom.endMs)) {
		for (const [cuts, junction] of [
			[trims, false],
			[junctions, true],
		] as const) {
			for (const c of cuts) {
				const resumes = Math.min(c.endMs, zoom.startMs);
				if (c.startMs <= zoom.startMs && resumes > resumesAt) {
					resumesAt = resumes;
					inByJunction = junction;
				}
				const jumps = Math.max(c.startMs, zoom.endMs);
				if (c.endMs >= zoom.endMs && jumps < jumpsAt) {
					jumpsAt = jumps;
					outByJunction = junction;
				}
			}
		}
	}
	return {
		inMs: resumesAt - transitions.inFromMs,
		outMs: transitions.outUntilMs - jumpsAt,
		inByJunction,
		outByJunction,
	};
}

export interface ChainedPan {
	/** Index of the zoom the pan leaves from its end: it has no zoom-out. */
	from: number;
	/** Index of the zoom the pan reaches: it has no zoom-in. */
	to: number;
	/** Timeline ms where the pan is over. It can run into the next zoom's span. */
	untilMs: number;
}

/**
 * The pans between chained zooms (mirror of `connected_pairs`, regions.rs): two consecutive
 * zooms at most 1.5 s apart on screen, panned between over 1 s of SCREEN time from the first
 * one's end. The compositor renders each clip segment on its own, so a cut between them
 * (a trim, or a clip junction as a zero-length span) breaks the chain, and a zoom entirely
 * under a trim takes no part in one.
 */
export function chainedPans(
	zooms: readonly Span[],
	speedRegions: readonly SpeedRegion[],
	cuts: readonly Span[],
): ChainedPan[] {
	const order = zooms
		.map((_, i) => i)
		.filter((i) => !cuts.some((c) => c.startMs <= zooms[i].startMs && c.endMs >= zooms[i].endMs))
		.sort((a, b) => zooms[a].startMs - zooms[b].startMs);
	return order.slice(1).flatMap((to, k) => {
		const from = order[k];
		const panFrom = screenTimeMs(speedRegions, zooms[from].endMs);
		const chained =
			screenTimeMs(speedRegions, zooms[to].startMs) - panFrom <= CHAINED_ZOOM_PAN_GAP_MS &&
			!cuts.some((c) => c.startMs <= zooms[to].startMs && c.endMs >= zooms[from].endMs);
		return chained
			? [
					{
						from,
						to,
						untilMs: timelineTimeMs(speedRegions, panFrom + CONNECTED_ZOOM_PAN_DURATION_MS),
					},
				]
			: [];
	});
}
