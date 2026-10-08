import { describe, expect, it, vi } from "vitest";
import { getSourcesByType, shouldEnumerateSourceTypesSeparately } from "./desktopSourceTypes";

describe("shouldEnumerateSourceTypesSeparately", () => {
	it("splits on Linux X11, including a bare Xvfb with no session variables", () => {
		expect(shouldEnumerateSourceTypesSeparately("linux", {})).toBe(true);
		expect(shouldEnumerateSourceTypesSeparately("linux", { XDG_SESSION_TYPE: "x11" })).toBe(true);
	});

	it("keeps one call on Wayland, where splitting would raise the portal twice", () => {
		expect(shouldEnumerateSourceTypesSeparately("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(
			false,
		);
		expect(shouldEnumerateSourceTypesSeparately("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(
			false,
		);
	});

	it("keeps one call on Windows and macOS", () => {
		expect(shouldEnumerateSourceTypesSeparately("win32", {})).toBe(false);
		expect(shouldEnumerateSourceTypesSeparately("darwin", {})).toBe(false);
	});
});

describe("getSourcesByType", () => {
	const opts: Electron.SourcesOptions = {
		types: ["screen", "window"],
		thumbnailSize: { width: 32, height: 18 },
	};

	it("asks one type per call, one call at a time, and concatenates in order", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const getSources = vi.fn(async (o: Electron.SourcesOptions) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight -= 1;
			return o.types.map((type) => `${type}:0`);
		});

		await expect(getSourcesByType(opts, getSources, true)).resolves.toEqual([
			"screen:0",
			"window:0",
		]);
		expect(getSources.mock.calls.map(([o]) => o)).toEqual([
			{ ...opts, types: ["screen"] },
			{ ...opts, types: ["window"] },
		]);
		expect(maxInFlight).toBe(1);
	});

	it("passes the request through untouched when not splitting", async () => {
		const getSources = vi.fn(async () => ["screen:0", "window:0"]);
		await getSourcesByType(opts, getSources, false);
		expect(getSources).toHaveBeenCalledExactlyOnceWith(opts);
	});

	it("passes a single-type request through as one call", async () => {
		const getSources = vi.fn(async () => ["screen:0"]);
		const screensOnly: Electron.SourcesOptions = { ...opts, types: ["screen"] };
		await getSourcesByType(screensOnly, getSources, true);
		expect(getSources).toHaveBeenCalledExactlyOnceWith(screensOnly);
	});

	it("propagates a failure of either call", async () => {
		const getSources = vi.fn(async (o: Electron.SourcesOptions) => {
			if (o.types[0] === "window") throw new Error("boom");
			return ["screen:0"];
		});
		await expect(getSourcesByType(opts, getSources, true)).rejects.toThrow("boom");
	});
});
