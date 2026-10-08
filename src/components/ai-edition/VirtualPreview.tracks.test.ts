import { describe, expect, it } from "vitest";
import { dropVideoTrack } from "./VirtualPreview";

/** A media element as Chromium shows it under `AudioVideoTracks`: track lists, nothing else. */
function element(tracks: { audio?: number; video?: number }) {
	const videoTracks = Array.from({ length: tracks.video ?? 0 }, (_, index) => ({
		selected: index === 0,
	}));
	return {
		element: {
			audioTracks: tracks.audio === undefined ? undefined : { length: tracks.audio },
			videoTracks: tracks.video === undefined ? undefined : videoTracks,
		} as unknown as HTMLMediaElement,
		videoTracks,
	};
}

describe("dropVideoTrack", () => {
	it("deselects the picture of an element that has sound to keep time with", () => {
		const { element: media, videoTracks } = element({ audio: 1, video: 1 });

		expect(dropVideoTrack(media)).toBe(true);
		expect(videoTracks[0].selected).toBe(false);
	});

	// With neither track selected an element has no stream left to keep time with: measured,
	// it jumps to its end on play. So it keeps time by the wall clock (issue #994).
	it("deselects the picture of a recording without sound too, and keeps time by the wall clock", () => {
		// Accessors on the prototype, where the element's own live.
		class Media extends EventTarget {
			duration = 10;
			time = 0;
			rate = 1;
			get currentTime() {
				return this.time;
			}
			set currentTime(sec: number) {
				this.time = sec;
			}
			get playbackRate() {
				return this.rate;
			}
			set playbackRate(rate: number) {
				this.rate = rate;
			}
			get paused() {
				return true;
			}
			play(): Promise<void> {
				throw new Error("played for real");
			}
			pause(): void {
				throw new Error("never playing for real, so never paused for real");
			}
		}
		const videoTracks = [{ selected: true }];
		const media = Object.assign(new Media(), {
			audioTracks: { length: 0 },
			videoTracks,
		}) as unknown as HTMLMediaElement;

		expect(dropVideoTrack(media)).toBe(true);
		expect(videoTracks[0].selected).toBe(false);
		void media.play();
		expect(media.paused).toBe(false);
	});

	it("does nothing where the track lists are absent (the Blink feature is off)", () => {
		const { element: media } = element({});

		expect(dropVideoTrack(media)).toBe(false);
	});

	it("does nothing to an element with no picture, the extracted second audio track", () => {
		const { element: media } = element({ audio: 1, video: 0 });

		expect(dropVideoTrack(media)).toBe(false);
	});
});
