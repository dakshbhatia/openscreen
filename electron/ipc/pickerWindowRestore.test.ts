import { describe, expect, it, vi } from "vitest";
import { presentPickerForWindow } from "./pickerWindowRestore";

function caller(url: string) {
	return {
		isDestroyed: vi.fn(() => false),
		isVisible: vi.fn(() => true),
		hide: vi.fn(),
		show: vi.fn(),
		showInactive: vi.fn(),
		focus: vi.fn(),
		webContents: { getURL: vi.fn(() => url) },
	};
}

describe("native picker caller restoration", () => {
	it.each([
		"http://localhost:5173/?windowType=editor",
		"file:///Applications/ProductIntel.app/Contents/Resources/app.asar/dist/index.html?windowType=editor",
	])("returns the research caller to the foreground after a choice: %s", async (url) => {
		const window = caller(url);
		let choose!: (value: string) => void;
		const pick = presentPickerForWindow(
			window,
			() =>
				new Promise<string>((resolve) => {
					choose = resolve;
				}),
		);
		expect(window.hide).toHaveBeenCalledOnce();
		expect(window.show).not.toHaveBeenCalled();
		choose("picked-window");
		expect(await pick).toBe("picked-window");
		expect(window.show).toHaveBeenCalledOnce();
		expect(window.focus).toHaveBeenCalledOnce();
		expect(window.showInactive).not.toHaveBeenCalled();
	});

	it("also restores research when the picker is cancelled or rejects", async () => {
		const window = caller("file:///app/index.html?windowType=editor");
		expect(await presentPickerForWindow(window, async () => null)).toBeNull();
		expect(window.focus).toHaveBeenCalledOnce();
		const failure = new Error("picker unavailable");
		await expect(
			presentPickerForWindow(window, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(window.focus).toHaveBeenCalledTimes(2);
	});

	it.each([
		"file:///app/index.html?windowType=hud-overlay",
		"file:///app/index.html?windowType=editor-extra",
		"file:///app/editor?return=windowType%3Deditor",
		"invalid URL windowType=editor",
	])("preserves nonactivating restore for other callers: %s", async (url) => {
		const window = caller(url);
		await presentPickerForWindow(window, async () => null);
		expect(window.showInactive).toHaveBeenCalledOnce();
		expect(window.show).not.toHaveBeenCalled();
		expect(window.focus).not.toHaveBeenCalled();
	});

	it("does not resurrect a caller destroyed while choosing", async () => {
		const window = caller("file:///app/index.html?windowType=editor");
		await presentPickerForWindow(window, async () => {
			window.isDestroyed.mockReturnValue(true);
			return null;
		});
		expect(window.show).not.toHaveBeenCalled();
		expect(window.showInactive).not.toHaveBeenCalled();
		expect(window.focus).not.toHaveBeenCalled();
		expect(window.webContents.getURL).not.toHaveBeenCalled();
	});

	it("does not focus a caller destroyed during restoration", async () => {
		const window = caller("file:///app/index.html?windowType=editor");
		window.show.mockImplementation(() => {
			window.isDestroyed.mockReturnValue(true);
		});
		await presentPickerForWindow(window, async () => null);
		expect(window.show).toHaveBeenCalledOnce();
		expect(window.focus).not.toHaveBeenCalled();
	});

	it("leaves already hidden, destroyed or missing callers alone", async () => {
		const window = caller("file:///app/index.html?windowType=editor");
		window.isVisible.mockReturnValue(false);
		await presentPickerForWindow(window, async () => null);
		window.isVisible.mockReturnValue(true);
		window.isDestroyed.mockReturnValue(true);
		await presentPickerForWindow(window, async () => null);
		expect(await presentPickerForWindow(null, async () => "choice")).toBe("choice");
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.show).not.toHaveBeenCalled();
		expect(window.showInactive).not.toHaveBeenCalled();
		expect(window.focus).not.toHaveBeenCalled();
	});
});
