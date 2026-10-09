import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type BrowserWindow, systemPreferences } from "electron";
import type { ScreenshotBatch } from "../../src/lib/screenshot-intel";
import { readMacScreenCaptureAccess } from "../native-bridge/screen/macScreenAccess";

const execute = promisify(execFile);

/** An explicit, interactive region/window capture. Originals enter the same managed import path. */
export class ScreenshotCapture {
	private pending = false;

	constructor(private readonly importImages: (paths: string[]) => Promise<ScreenshotBatch>) {}

	async access(
		platform: NodeJS.Platform,
	): Promise<{ status: "granted" | "not-determined" | "denied" | "restricted" | "unknown" }> {
		if (platform !== "darwin") return { status: "unknown" };
		// Electron caches a denied grant. The short-lived native probe observes a change in Settings.
		const probe = await readMacScreenCaptureAccess();
		if (probe.status === "granted" || probe.status === "denied") return { status: probe.status };
		return { status: systemPreferences.getMediaAccessStatus("screen") };
	}

	async capture(
		owner: BrowserWindow | null,
		platform: NodeJS.Platform,
	): Promise<ScreenshotBatch | null> {
		if (platform !== "darwin")
			throw new Error("Use your system screenshot tool, then drop the images here.");
		if ((await this.access(platform)).status !== "granted") {
			throw new Error(
				"Allow Product Intel in System Settings → Privacy & Security → Screen Recording, then retry.",
			);
		}
		if (this.pending) throw new Error("Finish the current screenshot selection first.");
		this.pending = true;
		let directory: string | null = null;
		const restoreWindow = !!owner && !owner.isDestroyed() && owner.isVisible();
		try {
			directory = await mkdtemp(path.join(tmpdir(), "product-intel-capture-"));
			const imagePath = path.join(directory, "Capture.png");
			if (restoreWindow) owner?.hide();
			try {
				await execute("/usr/sbin/screencapture", ["-i", "-x", "-t", "png", imagePath], {
					timeout: 180_000,
					maxBuffer: 64 * 1024,
				});
			} catch (error) {
				if ((await this.access(platform)).status !== "granted") {
					throw new Error(
						"Allow Product Intel in System Settings → Privacy & Security → Screen Recording, then retry.",
					);
				}
				// macOS exits with 1 when Escape cancels its interactive selector.
				if (error && typeof error === "object" && "code" in error && error.code === 1) return null;
				throw new Error(
					"Screenshot capture could not finish. Try again or drop a screenshot here.",
				);
			}
			try {
				if ((await stat(imagePath)).size === 0) return null;
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
					return null;
				throw error;
			}
			return await this.importImages([imagePath]);
		} finally {
			try {
				if (directory) await rm(directory, { recursive: true, force: true });
			} finally {
				this.pending = false;
				if (restoreWindow && owner && !owner.isDestroyed()) {
					owner.show();
					owner.focus();
				}
			}
		}
	}
}
