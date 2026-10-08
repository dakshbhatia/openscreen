import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepTimeByWallClock } from "./wallClock";

/** The slice of HTMLMediaElement the clock touches, playing for real when asked to. */
class FakeMedia extends EventTarget {
	duration = 40;
	nativePlays = 0;
	nativePauses = 0;
	seeks: number[] = [];
	#time = 0;
	#rate = 1;
	#paused = true;
	get currentTime() {
		return this.#time;
	}
	set currentTime(sec: number) {
		this.seeks.push(sec);
		this.#time = Math.min(sec, this.duration);
	}
	get playbackRate() {
		return this.#rate;
	}
	set playbackRate(value: number) {
		if (value > 16) throw new DOMException("rate", "NotSupportedError");
		this.#rate = value;
	}
	get paused() {
		return this.#paused;
	}
	play() {
		this.nativePlays++;
		this.#paused = false;
		return Promise.resolve();
	}
	pause() {
		this.nativePauses++;
		this.#paused = true;
	}
}

let nowMs = 0;
const clock = () => nowMs;

function clocked() {
	const media = new FakeMedia();
	keepTimeByWallClock(media as unknown as HTMLMediaElement, clock);
	return media as unknown as HTMLMediaElement & FakeMedia;
}

function events(media: EventTarget) {
	const seen: string[] = [];
	for (const type of ["play", "playing", "pause", "ended"]) {
		media.addEventListener(type, () => seen.push(type));
	}
	return seen;
}

beforeEach(() => {
	nowMs = 0;
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("keepTimeByWallClock", () => {
	it("advances at playbackRate times the wall clock while playing, without playing for real", async () => {
		const media = clocked();
		await media.play();
		nowMs = 1000;
		expect(media.currentTime).toBeCloseTo(1);
		media.playbackRate = 3;
		nowMs = 3000;
		expect(media.currentTime).toBeCloseTo(7);
		expect(media.paused).toBe(false);
		expect(media.nativePlays).toBe(0);
	});

	it("holds still while paused, and resumes from there", async () => {
		const media = clocked();
		await media.play();
		nowMs = 2000;
		media.pause();
		nowMs = 5000;
		expect(media.currentTime).toBeCloseTo(2);
		await media.play();
		nowMs = 5500;
		expect(media.currentTime).toBeCloseTo(2.5);
	});

	it("seeks the element, so seeking and seeked stay real, and runs on from the target", async () => {
		const media = clocked();
		await media.play();
		nowMs = 1000;
		media.currentTime = 10;
		expect(media.seeks).toEqual([10]);
		nowMs = 2000;
		expect(media.currentTime).toBeCloseTo(11);
	});

	it("fires the events a playing element fires, queued", async () => {
		const media = clocked();
		const seen = events(media);
		void media.play();
		expect(seen).toEqual([]);
		await Promise.resolve();
		media.pause();
		await Promise.resolve();
		expect(seen).toEqual(["play", "playing", "pause"]);
	});

	it("stops at the end and says so, then starts over on play", async () => {
		const media = clocked();
		const seen = events(media);
		media.currentTime = 38;
		media.playbackRate = 2;
		await media.play();
		nowMs = 1000;
		vi.advanceTimersByTime(1000);
		await Promise.resolve();
		expect(media.currentTime).toBe(40);
		expect(media.paused).toBe(true);
		expect(media.ended).toBe(true);
		expect(seen).toEqual(["play", "playing", "pause", "ended"]);
		await media.play();
		expect(media.currentTime).toBe(0);
	});

	it("still stops at the end when the duration is learned while playing (a MediaRecorder WebM)", async () => {
		const media = clocked();
		media.duration = Number.NaN;
		const seen = events(media);
		await media.play();
		media.duration = 2;
		media.dispatchEvent(new Event("durationchange"));
		nowMs = 2000;
		vi.advanceTimersByTime(2000);
		await Promise.resolve();
		expect(media.paused).toBe(true);
		expect(media.ended).toBe(true);
		expect(seen).toEqual(["play", "playing", "pause", "ended"]);
	});

	it("refuses a rate the element refuses, and keeps its own", async () => {
		const media = clocked();
		await media.play();
		expect(() => {
			media.playbackRate = 17;
		}).toThrow();
		nowMs = 1000;
		expect(media.playbackRate).toBe(1);
		expect(media.currentTime).toBeCloseTo(1);
	});

	it("stops an element that was already playing for real", () => {
		const media = new FakeMedia();
		void media.play();
		keepTimeByWallClock(media as unknown as HTMLMediaElement, clock);
		expect(media.nativePauses).toBe(1);
		expect(media.paused).toBe(true);
	});

	it("starts over, paused at 0, when the element is reloaded", async () => {
		const media = clocked();
		await media.play();
		nowMs = 3000;
		media.dispatchEvent(new Event("emptied"));
		expect(media.paused).toBe(true);
		expect(media.currentTime).toBe(0);
	});
});
