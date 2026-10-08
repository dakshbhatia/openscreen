/**
 * Makes a media element keep time by the wall clock instead of by playing (issue #994).
 *
 * The preview's `<video>` and `<audio>` only keep time: the native compositor draws every
 * pixel. A recording with sound keeps time on its sound track, its picture deselected
 * (`dropVideoTrack`). A recording without sound has nothing else to keep time with, so
 * Chromium decoded its picture on the GPU, twice (the `<video>` and the `<audio>`), at the
 * speed region's rate, against the compositor's own decode of the same file. Measured on an
 * RTX 4070 Ti with a hidden Electron playing a soundless 4K60 file the way the editor does,
 * next to the compositor's free-run at 3x: the view fell 3.5 s of playback behind; with one
 * Chromium decode left, 2.8 s; with this clock, 0.01 s, as with no Chromium at all.
 *
 * An element given this clock never plays for real: `play`, `pause`, `paused`, `ended`,
 * `currentTime` and `playbackRate` are answered by a clock that runs `playbackRate` times the
 * wall clock from where it was last placed, and it fires `play`, `playing`, `pause` and `ended`
 * as a playing element would. A seek still reaches the element, so `seeking` and `seeked` stay
 * real, and with no track selected it decodes nothing. Anything else is the element's own.
 */

const clocked = new WeakSet<HTMLMediaElement>();

function nativeDescriptor(element: HTMLMediaElement, key: string): PropertyDescriptor {
	for (let proto = Object.getPrototypeOf(element); proto; proto = Object.getPrototypeOf(proto)) {
		const descriptor = Object.getOwnPropertyDescriptor(proto, key);
		if (descriptor) return descriptor;
	}
	throw new Error(`media element without ${key}`);
}

export function keepTimeByWallClock(
	element: HTMLMediaElement,
	nowMs: () => number = () => performance.now(),
): void {
	if (clocked.has(element)) return;
	clocked.add(element);
	const time = nativeDescriptor(element, "currentTime");
	const rateOf = nativeDescriptor(element, "playbackRate");
	const nativePause = nativeDescriptor(element, "pause").value as () => void;

	// Loaded and already playing for real (a `play()` that beat the metadata): it stops here,
	// and says so with its own `pause` event.
	if (!nativeDescriptor(element, "paused").get?.call(element)) {
		nativePause.call(element);
	}

	let playing = false;
	let rate: number = rateOf.get?.call(element);
	let anchorSec: number = time.get?.call(element);
	let anchorMs = nowMs();
	let endTimer: ReturnType<typeof setTimeout> | undefined;

	const position = () => {
		const sec = playing ? anchorSec + ((nowMs() - anchorMs) / 1000) * rate : anchorSec;
		const duration = element.duration;
		return Math.max(0, Number.isFinite(duration) ? Math.min(sec, duration) : sec);
	};
	const atEnd = () => Number.isFinite(element.duration) && position() >= element.duration;
	// Queued like the element's own events, never fired from inside the call.
	const fire = (...types: string[]) =>
		queueMicrotask(() => {
			for (const type of types) element.dispatchEvent(new Event(type));
		});
	const anchor = (sec: number) => {
		anchorSec = sec;
		anchorMs = nowMs();
		clearTimeout(endTimer);
		const duration = element.duration;
		if (!playing || rate <= 0 || !Number.isFinite(duration)) return;
		endTimer = setTimeout(
			() => {
				if (!atEnd()) {
					anchor(position());
					return;
				}
				playing = false;
				anchor(duration);
				fire("pause", "ended");
			},
			((duration - sec) / rate) * 1000,
		);
	};

	Object.defineProperties(element, {
		currentTime: {
			configurable: true,
			get: position,
			set(sec: number) {
				time.set?.call(element, sec);
				anchor(time.get?.call(element));
			},
		},
		playbackRate: {
			configurable: true,
			get: () => rate,
			set(value: number) {
				const sec = position();
				// The element's own setter first: it is the one that refuses a rate (above 16).
				rateOf.set?.call(element, value);
				rate = value;
				anchor(sec);
			},
		},
		paused: { configurable: true, get: () => !playing },
		ended: { configurable: true, get: () => !playing && atEnd() },
		play: {
			configurable: true,
			value: () => {
				if (!playing) {
					// Like the element: playing again from the end starts over.
					if (atEnd()) element.currentTime = 0;
					playing = true;
					anchor(anchorSec);
					fire("play", "playing");
				}
				return Promise.resolve();
			},
		},
		pause: {
			configurable: true,
			value: () => {
				if (!playing) return;
				const sec = position();
				playing = false;
				anchor(sec);
				fire("pause");
			},
		},
	});

	// `load()` (a reload after an error) starts the element over, paused at 0.
	element.addEventListener("emptied", () => {
		playing = false;
		rate = rateOf.get?.call(element);
		anchor(0);
	});
}
