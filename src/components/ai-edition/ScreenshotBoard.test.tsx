// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTEL_SETTINGS } from "@/lib/product-intel";
import type { ScreenshotBatch } from "@/lib/screenshot-intel";
import { nativeBridgeClient } from "@/native/client";
import { ScreenshotBoard } from "./ScreenshotBoard";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		productIntel: { snapshot: vi.fn(), saveSettings: vi.fn() },
		aiEdition: { llmSetApiKey: vi.fn() },
		screenshotIntel: {
			pick: vi.fn(),
			import: vi.fn(),
			list: vi.fn(),
			get: vi.fn(),
			analyze: vi.fn(),
			cancel: vi.fn(),
			organize: vi.fn(),
			reveal: vi.fn(),
		},
	},
}));
const batch: ScreenshotBatch = {
	id: "batch_00000000-0000-0000-0000-000000000001",
	title: "Product screenshots",
	createdAt: "2026-10-08T12:00:00Z",
	images: Array.from({ length: 4 }, (_, index) => ({
		id: `image_00000000-0000-0000-0000-00000000000${index + 1}`,
		originalName: `Capture ${index + 1}.png`,
		path: `/Users/test/private/Capture ${index + 1}.png`,
		mimeType: "image/png",
		width: 1200,
		height: 800,
	})),
	analysis: null,
};
const analyzed: ScreenshotBatch = {
	...batch,
	settings: { ...DEFAULT_INTEL_SETTINGS, systemPrompt: "PRIVATE INSTRUCTIONS" },
	organizedPath: "/Users/test/managed/organized",
	analyzedAt: "2026-10-08T12:01:00Z",
	analysis: {
		summary: "Setup uses focused choices.",
		screens: batch.images.map((image, index) => ({
			imageId: image.id,
			label: `AI name ${index + 1}`,
			group: index < 2 ? "Setup" : "Workspace",
			observation: `Observation ${index + 1}`,
			hypothesis: `Hypothesis ${index + 1}`,
			advice: `Advice ${index + 1}`,
			confidence: "medium",
		})),
		unknowns: ["Conversion is unknown"],
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
		settings: DEFAULT_INTEL_SETTINGS,
		connected: true,
		report: null,
		status: null,
	});
	vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockImplementation(
		async (settings) => settings,
	);
	vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([]);
	vi.mocked(nativeBridgeClient.screenshotIntel.pick).mockResolvedValue(batch);
	vi.mocked(nativeBridgeClient.screenshotIntel.import).mockResolvedValue(batch);
	vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockResolvedValue(analyzed);
	vi.mocked(nativeBridgeClient.screenshotIntel.reveal).mockResolvedValue();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function importBatch() {
	render(<ScreenshotBoard active />);
	const add = await screen.findByRole("button", { name: "Add screenshots" });
	await waitFor(() => expect(add).toBeEnabled());
	fireEvent.click(add);
	await screen.findByRole("button", { name: "View Capture 1.png" });
}

describe("ScreenshotBoard", () => {
	it("keeps settings and history hidden while the primary import and analyze actions stay visible", async () => {
		await importBatch();
		expect(screen.getByLabelText("Our product")).toBeVisible();
		expect(screen.getByRole("button", { name: "Analyze screenshots" })).toBeEnabled();
		expect(screen.getByLabelText("Model")).not.toBeVisible();
		expect(screen.getByLabelText("Recent research")).not.toBeVisible();
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		expect(screen.getByLabelText("Recent research")).toBeVisible();
	});
	it("saves exact product context and shows grouped AI names, three advices and enlarged evidence", async () => {
		await importBatch();
		fireEvent.change(screen.getByLabelText("Our product"), {
			target: { value: "Our quirky product words." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Analyze screenshots" }));
		await screen.findByText("Setup uses focused choices.");
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ productBrief: "Our quirky product words." }),
		);
		expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledWith(batch.id);
		expect(screen.getByRole("region", { name: "Setup" })).toBeVisible();
		const advice = screen.getByRole("region", { name: "Product advice" });
		expect(within(advice).getByText("Advice 3")).toBeVisible();
		expect(within(advice).queryByText("Advice 4")).not.toBeInTheDocument();
		expect(screen.getAllByText("Hypothesis 1")[0]).not.toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "View AI name 1" }));
		expect(screen.getByRole("dialog")).toBeVisible();
		expect(
			within(screen.getByRole("dialog")).getByRole("img", { name: "AI name 1" }),
		).toHaveAttribute("src", expect.stringContaining("Capture%201.png"));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
		fireEvent.click(screen.getByRole("button", { name: "Open organized folder" }));
		expect(nativeBridgeClient.screenshotIntel.reveal).toHaveBeenCalledWith(batch.id);
	});
	it("imports dropped files using the native path bridge", async () => {
		vi.stubGlobal("electronAPI", { getPathForFile: vi.fn((file: File) => `/tmp/${file.name}`) });
		render(<ScreenshotBoard active />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Add screenshots" })).toBeEnabled(),
		);
		fireEvent.drop(screen.getByRole("region", { name: "Screenshot research" }), {
			dataTransfer: { files: [new File(["pixels"], "one.png", { type: "image/png" })] },
		});
		await screen.findByRole("button", { name: "View Capture 1.png" });
		expect(nativeBridgeClient.screenshotIntel.import).toHaveBeenCalledWith(["/tmp/one.png"]);
	});
	it("keeps key setup hidden until Analyze reveals it and focuses the field", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			connected: false,
			report: null,
			status: null,
		});
		vi.mocked(nativeBridgeClient.aiEdition.llmSetApiKey).mockResolvedValue({ success: true });
		await importBatch();
		expect(screen.getByRole("button", { name: "Analyze screenshots" })).toBeEnabled();
		expect(screen.getByLabelText("Gemini API key")).not.toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Analyze screenshots" }));
		expect(screen.getByLabelText("Gemini API key")).toBeVisible();
		expect(screen.getByLabelText("Gemini API key")).toHaveFocus();
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "secret-key" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Gemini key" }));
		await screen.findByText("Gemini key saved");
		expect(screen.getByLabelText("Gemini API key")).toHaveValue("");
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		expect(screen.getByText("Gemini key saved")).not.toBeVisible();
		expect(screen.getByRole("button", { name: "Analyze screenshots" })).toBeEnabled();
	});
	it("preserves the imported screenshots after a failed analysis and permits retry", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockRejectedValueOnce(
			new Error("Gemini quota exceeded"),
		);
		await importBatch();
		fireEvent.click(screen.getByRole("button", { name: "Analyze screenshots" }));
		await screen.findByRole("alert");
		expect(screen.getByRole("alert")).toHaveTextContent("Gemini quota exceeded");
		expect(screen.getByRole("button", { name: "View Capture 1.png" })).toBeVisible();
		expect(screen.queryByText("Setup uses focused choices.")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Analyze screenshots" }));
		await screen.findByText("Setup uses focused choices.");
	});
	it("marks advice stale after context changes", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([
			{ ...analyzed, settings: DEFAULT_INTEL_SETTINGS },
		]);
		render(<ScreenshotBoard active />);
		await screen.findByText("Setup uses focused choices.");
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Our product"), { target: { value: "New context" } });
		expect(screen.getByRole("note")).toHaveTextContent("Context changed");
	});
	it("exports shareable JSON without managed paths or private instructions", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([analyzed]);
		const create = vi.fn((_blob: Blob) => "blob:report");
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL = create;
				static revokeObjectURL = vi.fn();
			},
		);
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
			/* Prevent jsdom navigation. */
		});
		render(<ScreenshotBoard active />);
		await screen.findByText("Setup uses focused choices.");
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
		const blob = create.mock.calls[0][0];
		const contents = await new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsText(blob);
		});
		expect(contents).toContain("Observation 1");
		expect(contents).not.toContain("/Users/test");
		expect(contents).not.toContain("PRIVATE INSTRUCTIONS");
		expect(contents).not.toContain("systemPrompt");
		expect(contents).not.toContain("organizedPath");
	});
	it("keeps Analyze disabled without screenshot input and hides key status by default", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			connected: false,
			report: null,
			status: null,
		});
		render(<ScreenshotBoard active />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Add screenshots" })).toBeEnabled(),
		);
		expect(screen.getByRole("button", { name: "Analyze screenshots" })).toBeDisabled();
		expect(screen.getByLabelText("Gemini API key")).not.toBeVisible();
	});
});
