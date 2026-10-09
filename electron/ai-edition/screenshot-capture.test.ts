import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenshotBatch } from "../../src/lib/screenshot-intel";
import { ScreenshotCapture } from "./screenshot-capture";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), permission: vi.fn(), probe: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execute }));
vi.mock("electron", () => ({ systemPreferences: { getMediaAccessStatus: mocks.permission } }));
vi.mock("../native-bridge/screen/macScreenAccess", () => ({
	readMacScreenCaptureAccess: mocks.probe,
}));

const batch = { id: "batch_test" } as ScreenshotBatch;
const owner = () => ({
	isDestroyed: vi.fn(() => false),
	isVisible: vi.fn(() => true),
	hide: vi.fn(),
	show: vi.fn(),
	focus: vi.fn(),
});
type Done = (error: Error | null, stdout?: string, stderr?: string) => void;
beforeEach(() => {
	vi.resetAllMocks();
	mocks.permission.mockReturnValue("granted");
	mocks.probe.mockResolvedValue({ status: "missing-helper", granted: false });
	mocks.execute.mockImplementation(
		(_exe: string, args: string[], _options: unknown, done: Done) => {
			void writeFile(args.at(-1)!, "own test screenshot").then(() => done(null, "", ""));
		},
	);
});

describe("interactive screenshot capture", () => {
	it("observes a permission granted in Settings even when Electron's status is cached", async () => {
		mocks.permission.mockReturnValue("denied");
		mocks.probe.mockResolvedValue({ status: "granted", granted: true });
		const capture = new ScreenshotCapture(async () => batch);
		expect(await capture.access("darwin")).toEqual({ status: "granted" });
		expect(await capture.capture(null, "darwin")).toBe(batch);
	});
	it("hides the app, imports only the chosen capture and removes the temporary original", async () => {
		const window = owner();
		let imported = "";
		const importImages = vi.fn(async (paths: string[]) => {
			imported = paths[0];
			await expect(access(imported)).resolves.toBeUndefined();
			expect(window.hide).toHaveBeenCalledOnce();
			expect(window.show).not.toHaveBeenCalled();
			return batch;
		});
		expect(
			await new ScreenshotCapture(importImages).capture(
				window as unknown as BrowserWindow,
				"darwin",
			),
		).toBe(batch);
		expect(mocks.execute).toHaveBeenCalledWith(
			"/usr/sbin/screencapture",
			["-i", "-x", "-t", "png", imported],
			expect.any(Object),
			expect.any(Function),
		);
		await expect(access(path.dirname(imported))).rejects.toMatchObject({ code: "ENOENT" });
		expect(window.show).toHaveBeenCalledOnce();
		expect(window.focus).toHaveBeenCalledOnce();
	});
	it("treats Escape as cancellation and keeps the library unchanged", async () => {
		mocks.execute.mockImplementation(
			(_exe: string, _args: string[], _options: unknown, done: Done) =>
				done(Object.assign(new Error("cancel"), { code: 1 })),
		);
		const importImages = vi.fn();
		const window = owner();
		expect(
			await new ScreenshotCapture(importImages).capture(
				window as unknown as BrowserWindow,
				"darwin",
			),
		).toBeNull();
		expect(importImages).not.toHaveBeenCalled();
		expect(window.show).toHaveBeenCalledOnce();
	});
	it("reports denied screen permission before hiding the app", async () => {
		mocks.permission.mockReturnValue("denied");
		const window = owner();
		await expect(
			new ScreenshotCapture(vi.fn()).capture(window as unknown as BrowserWindow, "darwin"),
		).rejects.toThrow("System Settings");
		expect(window.hide).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it("cleans up and restores the window if managed import rejects the image", async () => {
		const window = owner();
		let captured = "";
		const capture = new ScreenshotCapture(async ([file]) => {
			captured = file;
			throw new Error("Invalid image");
		});
		await expect(capture.capture(window as unknown as BrowserWindow, "darwin")).rejects.toThrow(
			"Invalid image",
		);
		await expect(access(path.dirname(captured))).rejects.toMatchObject({ code: "ENOENT" });
		expect(window.show).toHaveBeenCalledOnce();
	});
	it("rejects concurrent selection and permits a new selection after completion", async () => {
		let finish: Done | undefined;
		mocks.execute.mockImplementation(
			(_exe: string, _args: string[], _options: unknown, done: Done) => {
				finish = done;
			},
		);
		const capture = new ScreenshotCapture(vi.fn());
		const first = capture.capture(null, "darwin");
		await vi.waitFor(() => expect(finish).toBeDefined());
		await expect(capture.capture(null, "darwin")).rejects.toThrow("current screenshot");
		finish?.(Object.assign(new Error("cancel"), { code: 1 }));
		await first;
		mocks.execute.mockImplementation(
			(_exe: string, _args: string[], _options: unknown, done: Done) =>
				done(Object.assign(new Error("cancel"), { code: 1 })),
		);
		await expect(capture.capture(null, "darwin")).resolves.toBeNull();
	});
	it("does not reveal a window that was hidden before capture", async () => {
		const window = owner();
		window.isVisible.mockReturnValue(false);
		await new ScreenshotCapture(async () => batch).capture(
			window as unknown as BrowserWindow,
			"darwin",
		);
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.show).not.toHaveBeenCalled();
	});
	it("offers system screenshot import on unsupported platforms", async () => {
		await expect(new ScreenshotCapture(vi.fn()).capture(null, "win32")).rejects.toThrow(
			"system screenshot tool",
		);
		expect(mocks.execute).not.toHaveBeenCalled();
	});
});
