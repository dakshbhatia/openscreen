import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridgeResponse } from "../../src/native/contracts";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const mocks = vi.hoisted(() => ({
	handle: vi.fn(),
	pick: vi.fn(),
	openPath: vi.fn(),
	import: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	analyze: vi.fn(),
	cancel: vi.fn(),
	organize: vi.fn(),
	owner: { isDestroyed: () => false },
}));
vi.mock("electron", () => ({
	app: { getPath: () => "/tmp/product-intel", getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: mocks.handle, removeHandler: vi.fn() },
	BrowserWindow: { fromWebContents: () => mocks.owner },
	shell: { openPath: mocks.openPath },
}));
vi.mock("../messageBox", () => ({ showOpenDialogOver: mocks.pick }));
vi.mock("../ai-edition/screenshot-intel-service", () => ({
	ScreenshotIntelService: class {
		import = mocks.import;
		list = mocks.list;
		get = mocks.get;
		analyze = mocks.analyze;
		cancel = mocks.cancel;
		organize = mocks.organize;
	},
}));
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {},
}));
vi.mock("../native-bridge/services/aiEditionService", () => ({ AiEditionService: class {} }));

let invoke: (action: string, payload?: unknown) => Promise<NativeBridgeResponse>;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.openPath.mockResolvedValue("");
	registerNativeBridgeHandlers({
		getPlatform: () => "darwin",
		getAiEditionDocuments: () => ({}),
		getAiEditionLlmConfig: () => ({}),
		getStylePresets: () => ({}),
	} as unknown as NativeBridgeContext);
	const handler = mocks.handle.mock.calls[0]?.[1] as (
		event: unknown,
		request: unknown,
	) => Promise<NativeBridgeResponse>;
	invoke = (action, payload) => handler({ sender: {} }, { domain: "aiEdition", action, payload });
});

describe("screenshot native bridge", () => {
	it("leaves the library untouched when the multi-image picker is cancelled", async () => {
		mocks.pick.mockResolvedValue({ canceled: true, filePaths: [] });
		const result = await invoke("screenshots.pick");
		expect(result).toMatchObject({ ok: true, data: null });
		expect(mocks.import).not.toHaveBeenCalled();
	});
	it("imports all chosen images through the managed screenshot service", async () => {
		mocks.pick.mockResolvedValue({ canceled: false, filePaths: ["/tmp/a.png", "/tmp/b.jpg"] });
		mocks.import.mockResolvedValue({ id: "batch_1" });
		expect(await invoke("screenshots.pick")).toMatchObject({ ok: true, data: { id: "batch_1" } });
		expect(mocks.pick).toHaveBeenCalledWith(
			mocks.owner,
			expect.objectContaining({ properties: ["openFile", "multiSelections"] }),
		);
		expect(mocks.import).toHaveBeenCalledWith(["/tmp/a.png", "/tmp/b.jpg"]);
	});
	it("only reveals the organized path resolved from the saved batch", async () => {
		mocks.get.mockResolvedValue({ organizedPath: "/tmp/product-intel/batch_1/organized" });
		expect(
			await invoke("screenshots.reveal", { batchId: "batch_1", path: "/untrusted" }),
		).toMatchObject({ ok: true });
		expect(mocks.openPath).toHaveBeenCalledWith("/tmp/product-intel/batch_1/organized");
	});
	it("does not open an arbitrary folder for an unanalyzed batch", async () => {
		mocks.get.mockResolvedValue({ organizedPath: undefined });
		expect(await invoke("screenshots.reveal", { batchId: "batch_1" })).toMatchObject({ ok: false });
		expect(mocks.openPath).not.toHaveBeenCalled();
	});
});
