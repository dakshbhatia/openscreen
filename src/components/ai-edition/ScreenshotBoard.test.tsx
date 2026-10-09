// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
function openMore() {
	const summary = screen.getByText("More", { selector: "summary" });
	if (!summary.parentElement?.hasAttribute("open")) fireEvent.click(summary);
}
async function browseScreens() {
	const button = await screen.findByRole("button", { name: /^Browse \d+ screens?$/ });
	if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
}

async function importBatch() {
	render(<ScreenshotBoard active />);
	const add = await screen.findByRole("button", { name: "Choose screenshots" });
	await waitFor(() => expect(add).toBeEnabled());
	fireEvent.click(add);
	await browseScreens();
	await screen.findByRole("button", { name: "View Capture 1.png" });
}

async function loadExistingBatch() {
	vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([batch]);
	render(<ScreenshotBoard active />);
	await browseScreens();
	await screen.findByRole("button", { name: "View Capture 1.png" });
}

describe("ScreenshotBoard", () => {
	it("keeps settings and history hidden while the primary import and analyze actions stay visible", async () => {
		await loadExistingBatch();
		expect(screen.getByLabelText("Our product")).not.toBeVisible();
		expect(screen.getByLabelText("Company domain (optional)")).not.toBeVisible();
		expect(screen.getByRole("button", { name: "Analyze screenshots" })).toBeEnabled();
		expect(screen.getByLabelText("Model")).not.toBeVisible();
		expect(screen.getByLabelText("Recent research")).not.toBeVisible();
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		expect(screen.getByLabelText("Recent research")).toBeVisible();
	});
	it("saves exact product context and shows grouped AI names, three advices and enlarged evidence", async () => {
		await loadExistingBatch();
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
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
		expect(screen.queryByText("Hypothesis 1")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "View AI name 1" }));
		expect(screen.getByRole("dialog")).toBeVisible();
		expect(within(screen.getByRole("dialog")).getByText("Hypothesis 1")).toBeVisible();
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
			expect(screen.getByRole("button", { name: "Choose screenshots" })).toBeEnabled(),
		);
		fireEvent.drop(screen.getByRole("region", { name: "Screenshot research" }), {
			dataTransfer: { files: [new File(["pixels"], "one.png", { type: "image/png" })] },
		});
		await browseScreens();
		await screen.findByRole("button", { name: "View AI name 1" });
		expect(nativeBridgeClient.screenshotIntel.import).toHaveBeenCalledWith(["/tmp/one.png"]);
		expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledExactlyOnceWith(batch.id);
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
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
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
			expect(screen.getByRole("button", { name: "Choose screenshots" })).toBeEnabled(),
		);
		expect(screen.queryByRole("button", { name: "Analyze screenshots" })).not.toBeInTheDocument();
		expect(screen.getByLabelText("Gemini API key")).not.toBeVisible();
	});
	it("automatically analyzes a newly picked batch with exact current context and sources collapsed", async () => {
		let finish: ((result: ScreenshotBatch) => void) | undefined;
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(<ScreenshotBoard active />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Choose screenshots" })).toBeEnabled(),
		);
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
		fireEvent.change(screen.getByLabelText("Our product"), {
			target: { value: "Our exact current context" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Choose screenshots" }));
		await screen.findByRole("button", { name: "Browse 4 screens" });
		expect(screen.getByRole("button", { name: "Browse 4 screens" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		await waitFor(() =>
			expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledExactlyOnceWith(batch.id),
		);
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ productBrief: "Our exact current context" }),
		);
		expect(screen.getByRole("status")).toHaveTextContent("Analyzing screenshots…");
		expect(screen.queryByRole("button", { name: "Analyze screenshots" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
		finish?.(analyzed);
		await screen.findByText("Setup uses focused choices.");
		expect(screen.getByRole("button", { name: "Open organized folder" })).toBeVisible();
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
	});
	it("does not analyze restored or selected recent batches", async () => {
		const other = {
			...batch,
			id: "batch_00000000-0000-0000-0000-000000000002",
			title: "Other research",
		};
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([batch, other]);
		vi.mocked(nativeBridgeClient.screenshotIntel.get).mockResolvedValue(other);
		render(<ScreenshotBoard active />);
		await browseScreens();
		await screen.findByRole("button", { name: "View Capture 1.png" });
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		fireEvent.change(screen.getByLabelText("Recent research"), { target: { value: other.id } });
		await waitFor(() => expect(screen.getByLabelText("Recent research")).toHaveValue(other.id));
		expect(nativeBridgeClient.screenshotIntel.get).toHaveBeenCalledWith(other.id);
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	});
	it("does not analyze when the screenshot picker is cancelled", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.pick).mockResolvedValue(null);
		render(<ScreenshotBoard active />);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Choose screenshots" })).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Choose screenshots" }));
		await waitFor(() => expect(nativeBridgeClient.screenshotIntel.pick).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Choose screenshots" })).toBeEnabled(),
		);
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
		expect(nativeBridgeClient.productIntel.saveSettings).not.toHaveBeenCalled();
	});
	it("autosaves the exact brief without blur and reports a failed save until retry succeeds", async () => {
		await loadExistingBatch();
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockRejectedValueOnce(
			new Error("Disk unavailable"),
		);
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
		fireEvent.change(screen.getByLabelText("Our product"), {
			target: { value: "Our words, untouched!!" },
		});
		await screen.findByText("Disk unavailable");
		expect(screen.getByText("Unsaved changes")).toBeVisible();
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
		fireEvent.blur(screen.getByLabelText("Our product"));
		await screen.findByText("Saved");
		expect(screen.queryByText("Disk unavailable")).not.toBeInTheDocument();
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenLastCalledWith(
			expect.objectContaining({ productBrief: "Our words, untouched!!" }),
		);
	});
	it("opens a saved product brief compactly and lets the user edit it without rewriting", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: { ...DEFAULT_INTEL_SETTINGS, productBrief: "My product — quirks intact." },
			connected: true,
			report: null,
			status: null,
		});
		await loadExistingBatch();
		expect(screen.getByLabelText("Our product")).not.toBeVisible();
		expect(screen.getByText("My product — quirks intact.", { selector: "p" })).not.toBeVisible();
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
		expect(screen.getByLabelText("Our product")).toBeVisible();
		expect(screen.getByLabelText("Our product")).toHaveValue("My product — quirks intact.");
	});
	it("searches finding text, intersects group filters and clears back to all screens", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([analyzed]);
		render(<ScreenshotBoard active />);
		await browseScreens();
		await screen.findByRole("button", { name: "View AI name 1" });
		fireEvent.change(screen.getByRole("searchbox", { name: "Search screenshots" }), {
			target: { value: "Advice 4" },
		});
		expect(screen.getByRole("button", { name: "View AI name 4" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "View AI name 1" })).not.toBeInTheDocument();
		expect(screen.getByText("1 of 4")).toBeVisible();
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Setup" } });
		expect(screen.getByText(/No screens match/)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(screen.getByRole("button", { name: "View AI name 1" })).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 4" })).toBeVisible();
	});
	it("navigates only filtered evidence with arrows and keeps hypotheses beside the source", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([analyzed]);
		render(<ScreenshotBoard active />);
		await browseScreens();
		await screen.findByRole("button", { name: "View AI name 1" });
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Workspace" } });
		fireEvent.click(screen.getByRole("button", { name: "View AI name 3" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByRole("button", { name: "Previous screenshot" })).toBeDisabled();
		expect(within(dialog).getByText("Hypothesis 3")).toBeVisible();
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img", { name: "AI name 4" })).toBeVisible();
		expect(within(dialog).getByRole("button", { name: "Next screenshot" })).toBeDisabled();
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img", { name: "AI name 4" })).toBeVisible();
		fireEvent.click(within(dialog).getByRole("button", { name: "Previous screenshot" }));
		expect(within(dialog).getByRole("img", { name: "AI name 3" })).toBeVisible();
	});
	it("clears a removed group when reanalysis renames groups in the same batch", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([analyzed]);
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockResolvedValue({
			...analyzed,
			analysis: {
				...analyzed.analysis!,
				screens: analyzed.analysis!.screens.map((item) => ({ ...item, group: "Onboarding" })),
			},
		});
		render(<ScreenshotBoard active />);
		await browseScreens();
		await screen.findByRole("button", { name: "View AI name 1" });
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Setup" } });
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
		await screen.findByRole("region", { name: "Onboarding" });
		expect(screen.getByRole("button", { name: "View AI name 4" })).toBeVisible();
		expect(screen.queryByText(/No screens match/)).not.toBeInTheDocument();
	});
	it("keeps full report text available while summary and unknowns expand independently", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([analyzed]);
		render(<ScreenshotBoard active />);
		const summary = await screen.findByText("Setup uses focused choices.");
		const previewClass = summary.className;
		fireEvent.click(screen.getByRole("button", { name: "Full summary" }));
		expect(summary.className).not.toBe(previewClass);
		expect(screen.getByRole("button", { name: "Less summary" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(screen.getByText("Conversion is unknown")).not.toBeVisible();
		fireEvent.click(
			screen.getByText("What these screens don’t establish (1)", { selector: "summary" }),
		);
		expect(screen.getByText("Conversion is unknown")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Inspect AI name 1" }));
		expect(within(screen.getByRole("dialog")).getByText("Advice 1")).toBeVisible();
	});
	it("labels history by purpose and date and explains skipped duplicates", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([
			{ ...analyzed, duplicatesSkipped: 2 },
			{ ...batch, id: "batch_00000000-0000-0000-0000-000000000002" },
		]);
		render(<ScreenshotBoard active />);
		await screen.findByText(/2 identical images skipped/);
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		expect(
			screen.getByRole("option", { name: /Setup \/ Workspace · 4 screens · Oct/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /Product screenshots.*Unanalyzed/ }),
		).toBeInTheDocument();
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	});
});

const intelligent: ScreenshotBatch = {
	...analyzed,
	companyContext: {
		domain: "https://example.com",
		status: "retrieved",
		sourceUrls: ["https://example.com/"],
	},
	analysis: {
		...analyzed.analysis!,
		understanding: {
			product: "A focused workspace",
			audience: "Small teams (inferred)",
			job: "Coordinate work",
			confidence: "medium",
		},
		decisions: [
			{
				title: "Test progressive setup",
				recommendation: "adapt",
				rationale: "Two screens expose focused choices",
				counterEvidence: "Existing users might prefer a dense form",
				experiment: "Compare completion errors with fewer fields",
				tradeoff: "Extra steps may slow experienced users",
				confidence: "medium",
				evidenceImageIds: [batch.images[3].id, batch.images[1].id],
			},
		],
	},
};
describe("collection intelligence", () => {
	it("shows cross-screen decisions with optional reasoning and only their cited evidence", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([intelligent]);
		render(<ScreenshotBoard active />);
		await screen.findByText("Test progressive setup");
		const advice = screen.getByRole("region", { name: "Product advice" });
		expect(within(advice).queryByText("Advice 1")).not.toBeInTheDocument();
		expect(screen.getByText("Existing users might prefer a dense form")).not.toBeVisible();
		fireEvent.click(screen.getByText("Why, alternatives & tradeoff", { selector: "summary" }));
		expect(screen.getByText("Existing users might prefer a dense form")).toBeVisible();
		expect(screen.getByText("Extra steps may slow experienced users")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Evidence for Test progressive setup" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByRole("img", { name: "AI name 4" })).toBeVisible();
		expect(within(dialog).getByText("Decision evidence · 1 of 2")).toBeVisible();
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img", { name: "AI name 2" })).toBeVisible();
		expect(within(dialog).getByRole("button", { name: "Next screenshot" })).toBeDisabled();
	});
	it("keeps inferred understanding collapsed and shows confirmed website grounding", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([intelligent]);
		render(<ScreenshotBoard active />);
		await screen.findByText("Test progressive setup");
		expect(screen.getByText("A focused workspace")).not.toBeVisible();
		fireEvent.click(
			screen.getByText("Working understanding · medium confidence", { selector: "summary" }),
		);
		expect(screen.getByText("A focused workspace")).toBeVisible();
		expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute(
			"href",
			"https://example.com/",
		);
	});
	it("does not force advice when evidence supports no product decision", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([
			{
				...intelligent,
				analysis: { ...intelligent.analysis!, decisions: [] },
				companyContext: { domain: "https://example.com", status: "unavailable", sourceUrls: [] },
			},
		]);
		render(<ScreenshotBoard active />);
		await screen.findByText(/No supported product decision yet/);
		expect(
			within(screen.getByRole("region", { name: "Product advice" })).queryByText("Advice 1"),
		).not.toBeInTheDocument();
		expect(screen.getByText(/Company site wasn’t retrieved/)).toBeVisible();
		expect(screen.queryByRole("link", { name: "example.com" })).not.toBeInTheDocument();
	});
	it("autosaves an optional company domain normalized by the backend without adding a brief", async () => {
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockImplementation(
			async (settings) => ({ ...settings, companyDomain: "https://example.com" }),
		);
		await loadExistingBatch();
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
		fireEvent.change(screen.getByLabelText("Company domain (optional)"), {
			target: { value: "example.com" },
		});
		await screen.findByText("Saved");
		expect(screen.getByLabelText("Company domain (optional)")).toHaveValue("https://example.com");
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ companyDomain: "example.com", productBrief: "" }),
		);
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	});
	it("searches decision rationale through its referenced screenshots", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([intelligent]);
		render(<ScreenshotBoard active />);
		await screen.findByText("Test progressive setup");
		await browseScreens();
		fireEvent.change(screen.getByRole("searchbox", { name: "Search screenshots" }), {
			target: { value: "dense form" },
		});
		expect(screen.getByText("2 of 4")).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 2" })).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 4" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "View AI name 1" })).not.toBeInTheDocument();
	});
	it.each([
		"JSON",
		"Markdown",
	])("exports %s with understanding, decision evidence and company grounding without private fields", async (format) => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([intelligent]);
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
		await screen.findByText("Test progressive setup");
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		fireEvent.click(screen.getByRole("button", { name: `Export ${format}` }));
		const contents = await new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsText(create.mock.calls[0][0]);
		});
		expect(contents).toContain("A focused workspace");
		expect(contents).toContain("Test progressive setup");
		expect(contents).toContain(batch.images[3].id);
		expect(contents).toContain("https://example.com/");
		if (format === "Markdown") expect(contents).toContain(`Screen ID: ${batch.images[3].id}`);
		expect(contents).not.toContain("/Users/test");
		expect(contents).not.toContain("PRIVATE INSTRUCTIONS");
		expect(contents).not.toContain("systemPrompt");
	});
});

it("keeps the latest context when a pending save completes before a delayed tab reload", async () => {
	vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([batch]);
	const view = render(<ScreenshotBoard active />);
	await browseScreens();
	await screen.findByRole("button", { name: "View Capture 1.png" });
	let finishSave: ((settings: typeof DEFAULT_INTEL_SETTINGS) => void) | undefined;
	vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishSave = resolve;
			}),
	);
	openMore();
	fireEvent.click(screen.getByRole("button", { name: "Our product Edit" }));
	fireEvent.change(screen.getByLabelText("Our product"), {
		target: { value: "Latest exact wording!!" },
	});
	fireEvent.blur(screen.getByLabelText("Our product"));
	await waitFor(() => expect(finishSave).toBeDefined());
	let finishList: ((items: ScreenshotBatch[]) => void) | undefined;
	vi.mocked(nativeBridgeClient.screenshotIntel.list).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishList = resolve;
			}),
	);
	view.rerender(<ScreenshotBoard active={false} />);
	view.rerender(<ScreenshotBoard active />);
	await waitFor(() => expect(finishList).toBeDefined());
	await act(async () => {
		finishSave?.({ ...DEFAULT_INTEL_SETTINGS, productBrief: "Latest exact wording!!" });
	});
	await act(async () => {
		finishList?.([batch]);
	});
	expect(screen.getByLabelText("Our product")).toHaveValue("Latest exact wording!!");
});

const brief: ScreenshotBatch = {
	...intelligent,
	analysis: {
		...intelligent.analysis!,
		readout: {
			strengths: [
				{
					title: "Focused choices",
					reason: "A bounded set of options reduces the setup decision burden.",
					basis: "observed",
					confidence: "high",
					evidenceImageIds: [batch.images[3].id, batch.images[1].id],
				},
			],
			frictions: [
				{
					title: "Unclear permission scope",
					reason:
						"The permission request may make the access decision harder without a scope preview.",
					basis: "inferred",
					confidence: "medium",
					evidenceImageIds: [batch.images[0].id],
				},
			],
		},
		screens: intelligent.analysis!.screens.map((item, index) => ({
			...item,
			purpose: [
				"Review requested permissions before choosing access.",
				"Choose a workspace setup option.",
				"Find a saved project in the workspace.",
				"Compare available setup choices.",
			][index],
		})),
		decisions: [
			intelligent.analysis!.decisions![0],
			...["Test discoverability", "Test permission clarity", "Test saved views"].map((title) => ({
				...intelligent.analysis!.decisions![0],
				title,
			})),
		],
	},
};

async function loadBrief(report = brief) {
	vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([report]);
	render(<ScreenshotBoard active />);
	await screen.findByRole("heading", { name: "Product brief" });
}

describe("Product brief", () => {
	it("shows product, job, both readout columns and one next step while details remain hidden", async () => {
		await loadBrief();
		expect(screen.getAllByRole("heading", { name: "Product brief" })).toHaveLength(1);
		expect(screen.queryByRole("heading", { name: "Product takeaways" })).not.toBeInTheDocument();
		const report = screen.getByRole("region", { name: "Product brief" });
		expect(within(report).getByText("A focused workspace")).toBeVisible();
		expect(within(report).getByText("Coordinate work")).toBeVisible();
		expect(within(report).getByText(/Small teams/)).not.toBeVisible();
		expect(within(report).getByText("Setup uses focused choices.")).not.toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Works well" })).getByText("Focused choices"),
		).toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Creates friction" })).getByText(
				"Unclear permission scope",
			),
		).toBeVisible();
		expect(within(report).getByText("observed · high confidence")).toBeVisible();
		expect(within(report).getByText("inferred · medium confidence")).toBeVisible();
		expect(screen.getByRole("heading", { name: "Recommended next step" })).toBeVisible();
		expect(within(report).getByText("Test progressive setup")).toBeVisible();
		expect(within(report).queryByText("Test discoverability")).not.toBeInTheDocument();
		expect(within(report).getByText("Existing users might prefer a dense form")).not.toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "More decisions (3)" }));
		expect(within(report).getByText("Test discoverability")).toBeVisible();
		expect(within(report).getByText("Test saved views")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Fewer decisions" }));
		expect(within(report).queryByText("Test discoverability")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Full summary" }));
		expect(within(report).getByText("Setup uses focused choices.")).toBeVisible();
		fireEvent.click(screen.getByText("Audience & confidence", { selector: "summary" }));
		expect(within(report).getByText(/Small teams/)).toBeVisible();
	});

	it("opens only cited screenshots for an insight, in its declared evidence order", async () => {
		await loadBrief();
		fireEvent.click(screen.getByRole("button", { name: "Evidence for Focused choices" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByRole("img", { name: "AI name 4" })).toBeVisible();
		expect(within(dialog).getByText("Cited evidence · 1 of 2")).toBeVisible();
		expect(within(dialog).getByRole("button", { name: "Previous screenshot" })).toBeDisabled();
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img", { name: "AI name 2" })).toBeVisible();
		expect(within(dialog).getByRole("button", { name: "Next screenshot" })).toBeDisabled();
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img", { name: "AI name 2" })).toBeVisible();
	});

	it("leaves unsupported sections and next steps empty instead of substituting per-screen advice", async () => {
		await loadBrief({
			...brief,
			analysis: { ...brief.analysis!, readout: { strengths: [], frictions: [] }, decisions: [] },
		});
		expect(screen.getByText("No supported strengths in these screens.")).toBeVisible();
		expect(screen.getByText("No supported friction in these screens.")).toBeVisible();
		expect(screen.getByText(/No supported product decision yet/)).toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Product brief" })).queryByText("Advice 1"),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /More decisions/ })).not.toBeInTheDocument();
	});

	it("shows screen purpose on gallery cards and explicitly in the evidence inspector", async () => {
		await loadBrief();
		await browseScreens();
		const card = screen.getByRole("button", { name: "View AI name 1" });
		expect(
			within(card).getByText("Review requested permissions before choosing access."),
		).toBeVisible();
		fireEvent.click(card);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Purpose")).toBeVisible();
		expect(
			within(dialog).getByText("Review requested permissions before choosing access."),
		).toBeVisible();
	});

	it("matches purpose to its screen and readout reasons only to their cited images", async () => {
		await loadBrief();
		await browseScreens();
		const search = screen.getByRole("searchbox", { name: "Search screenshots" });
		fireEvent.change(search, { target: { value: "saved project" } });
		expect(screen.getByText("1 of 4")).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 3" })).toBeVisible();
		fireEvent.change(search, { target: { value: "decision burden" } });
		expect(screen.getByText("2 of 4")).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 2" })).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 4" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "View AI name 1" })).not.toBeInTheDocument();
		fireEvent.change(search, { target: { value: "scope preview" } });
		expect(screen.getByText("1 of 4")).toBeVisible();
		expect(screen.getByRole("button", { name: "View AI name 1" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "View AI name 2" })).not.toBeInTheDocument();
	});

	it.each([
		"JSON",
		"Markdown",
	])("exports %s readout and purposes with evidence labels and explicit private-field exclusion", async (format) => {
		const secret = `AIza${"a".repeat(35)}`;
		const unsafeInsight = {
			...brief.analysis!.readout!.strengths[0],
			reason: `A bounded setup choice. ${secret} /Users/test/private/source.png`,
			apiKey: "UNEXPORTED SECRET FIELD",
			path: "/Users/test/private/managed.png",
			systemPrompt: "UNEXPORTED INSIGHT PROMPT",
		};
		const report = {
			...brief,
			analysis: {
				...brief.analysis!,
				readout: { ...brief.analysis!.readout!, strengths: [unsafeInsight] },
				screens: brief.analysis!.screens.map((item) => ({
					...item,
					purpose: `${item.purpose} ${secret} /Users/test/private/source.png`,
				})),
			},
		};
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
		await loadBrief(report);
		fireEvent.click(screen.getByText("More", { selector: "summary" }));
		fireEvent.click(screen.getByRole("button", { name: `Export ${format}` }));
		const contents = await new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsText(create.mock.calls[0][0]);
		});
		expect(contents).toContain("Focused choices");
		expect(contents).toContain("Unclear permission scope");
		expect(contents).toContain("Review requested permissions before choosing access.");
		expect(contents).not.toContain(secret);
		expect(contents).not.toContain("/Users/test");
		expect(contents).not.toContain("UNEXPORTED");
		expect(contents).not.toContain("PRIVATE INSTRUCTIONS");
		expect(contents).not.toContain("systemPrompt");
		if (format === "JSON") {
			const exported = JSON.parse(contents) as {
				analysis: {
					readout: { strengths: unknown[] };
					screens: Array<{ imageId: string; label: string; purpose: string }>;
				};
			};
			expect(exported.analysis.readout.strengths[0]).toEqual({
				title: "Focused choices",
				reason: "A bounded setup choice. [redacted] [redacted]",
				basis: "observed",
				confidence: "high",
				evidenceImageIds: [batch.images[3].id, batch.images[1].id],
			});
			expect(
				exported.analysis.screens.find((item) => item.imageId === batch.images[3].id)?.label,
			).toBe("AI name 4");
		} else {
			expect(contents).toContain("## Works well");
			expect(contents).toContain("## Creates friction");
			expect(contents).toContain(
				`Evidence: ${batch.images[3].id} (AI name 4), ${batch.images[1].id} (AI name 2)`,
			);
			expect(contents).toContain("Purpose: Review requested permissions before choosing access.");
		}
	});

	it("retains the three-decision legacy view for stored reports without a readout", async () => {
		const { readout: _readout, ...legacyAnalysis } = brief.analysis!;
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([
			{ ...brief, analysis: legacyAnalysis },
		]);
		render(<ScreenshotBoard active />);
		await screen.findByRole("heading", { name: "Product takeaways" });
		expect(screen.getByText("Test permission clarity")).toBeVisible();
		expect(screen.queryByText("Test saved views")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "More decisions (1)" })).toBeVisible();
		expect(screen.queryByRole("region", { name: "Works well" })).not.toBeInTheDocument();
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	});
});

const bulk: ScreenshotBatch = {
	...brief,
	images: Array.from({ length: 120 }, (_, index) => ({
		...batch.images[0],
		id: `image_${String(index + 1).padStart(8, "0")}-0000-0000-0000-000000000000`,
		originalName: `Bulk ${index + 1}.png`,
		path: `/Users/test/private/Bulk ${index + 1}.png`,
	})),
	analysis: {
		...brief.analysis!,
		screens: Array.from({ length: 120 }, (_, index) => ({
			...brief.analysis!.screens[0],
			imageId: `image_${String(index + 1).padStart(8, "0")}-0000-0000-0000-000000000000`,
			label: `Screen ${index + 1}`,
			group: index < 60 ? "Setup" : "Workspace",
			purpose: index === 119 ? "Unique final screen purpose" : "Review a product screen",
		})),
		readout: {
			strengths: [
				{
					...brief.analysis!.readout!.strengths[0],
					evidenceImageIds: [
						"image_00000025-0000-0000-0000-000000000000",
						"image_00000120-0000-0000-0000-000000000000",
					],
				},
			],
			frictions: [],
		},
	},
};

describe("quiet bulk screenshot workflow", () => {
	it("shows only representative group thumbnails until Browse expands the source library", async () => {
		await loadBrief(bulk);
		expect(screen.getByText("Drop screenshots here")).toBeVisible();
		expect(screen.getByText("Up to 120 PNG, JPEG or WebP images")).toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Screen groups" })).getAllByRole("img"),
		).toHaveLength(2);
		expect(screen.queryByRole("button", { name: /^View / })).not.toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Screen group")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Analyze screenshots" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Analyze again" })).not.toBeVisible();
		expect(screen.getByRole("button", { name: "Open organized folder" })).not.toBeVisible();
		await browseScreens();
		expect(
			within(screen.getByRole("region", { name: "Screenshot library" })).getAllByRole("img"),
		).toHaveLength(24);
		fireEvent.click(screen.getByRole("button", { name: "Browse 120 screens" }));
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		openMore();
		expect(screen.getByRole("button", { name: "Analyze again" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Open organized folder" })).toBeVisible();
	});
	it("bounds a 120-screen library to 24 cards, reaches the last page and searches the full batch", async () => {
		await loadBrief(bulk);
		await browseScreens();
		expect(screen.getByText("Page 1 of 5")).toBeVisible();
		expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
		for (let page = 0; page < 4; page++)
			fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(screen.getByText("Page 5 of 5")).toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Screenshot library" })).getAllByRole("img"),
		).toHaveLength(24);
		expect(screen.getByRole("button", { name: "View Screen 120" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
		fireEvent.change(screen.getByRole("searchbox", { name: "Search screenshots" }), {
			target: { value: "Unique final" },
		});
		expect(screen.getByText("1 of 120")).toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Screenshot library" })).getAllByRole("img"),
		).toHaveLength(1);
		expect(screen.getByRole("button", { name: "View Screen 120" })).toBeVisible();
		fireEvent.change(screen.getByRole("searchbox", { name: "Search screenshots" }), {
			target: { value: "" },
		});
		expect(screen.getByText("Page 1 of 5")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Workspace" } });
		expect(screen.getByText("Page 1 of 3")).toBeVisible();
		expect(screen.getByRole("button", { name: "View Screen 61" })).toBeVisible();
	});
	it("opens cited screens across page boundaries without mounting the library", async () => {
		await loadBrief(bulk);
		fireEvent.click(screen.getByRole("button", { name: "Evidence for Focused choices" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByRole("img", { name: "Screen 25" })).toBeVisible();
		fireEvent.click(within(dialog).getByRole("button", { name: "Next screenshot" }));
		expect(within(dialog).getByRole("img", { name: "Screen 120" })).toBeVisible();
		fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Browse 120 screens" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});
	it("navigates filtered evidence beyond the current source page", async () => {
		await loadBrief(bulk);
		await browseScreens();
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Workspace" } });
		fireEvent.click(screen.getByRole("button", { name: "View Screen 84" }));
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(within(dialog).getByRole("img", { name: "Screen 85" })).toBeVisible();
		expect(within(dialog).getByText("25 of 60")).toBeVisible();
	});
	it("preserves an open library and surviving group on same-batch reanalysis", async () => {
		await loadBrief(bulk);
		await browseScreens();
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Workspace" } });
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockResolvedValue(bulk);
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
		await waitFor(() => expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Analyze again" })).toBeEnabled(),
		);
		expect(screen.getByRole("button", { name: "Browse 120 screens" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(screen.getByLabelText("Screen group")).toHaveValue("Workspace");
		expect(screen.getByText("Page 2 of 3")).toBeVisible();
	});
	it("resets sources, filters and pagination when selecting history without importing or analyzing", async () => {
		const other = { ...brief, id: "batch_00000000-0000-0000-0000-000000000002" };
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([bulk, other]);
		vi.mocked(nativeBridgeClient.screenshotIntel.get).mockResolvedValue(other);
		render(<ScreenshotBoard active />);
		await browseScreens();
		fireEvent.change(screen.getByLabelText("Screen group"), { target: { value: "Workspace" } });
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		fireEvent.change(screen.getByRole("searchbox", { name: "Search screenshots" }), {
			target: { value: "Review" },
		});
		openMore();
		fireEvent.change(screen.getByLabelText("Recent research"), { target: { value: other.id } });
		await waitFor(() => expect(screen.getByLabelText("Recent research")).toHaveValue(other.id));
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		await browseScreens();
		expect(screen.getByLabelText("Screen group")).toHaveValue("");
		expect(screen.getByRole("searchbox", { name: "Search screenshots" })).toHaveValue("");
		expect(
			within(screen.getByRole("region", { name: "Screenshot library" })).getAllByRole("img"),
		).toHaveLength(4);
		expect(nativeBridgeClient.screenshotIntel.import).not.toHaveBeenCalled();
		expect(nativeBridgeClient.screenshotIntel.pick).not.toHaveBeenCalled();
		expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	});
	it("keeps a failed bulk import available for retry with sources collapsed and no repeated picker", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.pick).mockResolvedValue({
			...bulk,
			analysis: null,
		});
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockRejectedValueOnce(
			new Error("Quota exceeded"),
		);
		render(<ScreenshotBoard active />);
		const choose = screen.getByRole("button", { name: "Choose screenshots" });
		await waitFor(() => expect(choose).toBeEnabled());
		fireEvent.click(choose);
		await screen.findByRole("alert");
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Browse 120 screens" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockResolvedValueOnce(bulk);
		fireEvent.click(screen.getByRole("button", { name: "Analyze screenshots" }));
		await screen.findByRole("heading", { name: "Product brief" });
		expect(nativeBridgeClient.screenshotIntel.pick).toHaveBeenCalledOnce();
		expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
	});
	it("cancels a pending analysis without losing imported sources or history", async () => {
		let rejectAnalysis: ((reason: Error) => void) | undefined;
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectAnalysis = reject;
				}),
		);
		vi.mocked(nativeBridgeClient.screenshotIntel.cancel).mockImplementationOnce(async () => {
			rejectAnalysis?.(new Error("Analysis cancelled"));
		});
		render(<ScreenshotBoard active />);
		const choose = screen.getByRole("button", { name: "Choose screenshots" });
		await waitFor(() => expect(choose).toBeEnabled());
		fireEvent.click(choose);
		await waitFor(() => expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledOnce());
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await screen.findByRole("alert");
		expect(nativeBridgeClient.screenshotIntel.cancel).toHaveBeenCalledExactlyOnceWith(batch.id);
		expect(screen.getByRole("button", { name: "Analyze screenshots" })).toBeEnabled();
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		openMore();
		expect(screen.getByLabelText("Recent research")).toHaveValue(batch.id);
		expect(nativeBridgeClient.screenshotIntel.pick).toHaveBeenCalledOnce();
	});
});

it.each([
	"automatic import",
	"manual retry",
])("cancels %s during settings preparation before any analysis job starts", async (mode) => {
	let releaseSave: (() => void) | undefined;
	vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseSave = () => resolve(DEFAULT_INTEL_SETTINGS);
			}),
	);
	if (mode === "manual retry")
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([batch]);
	render(<ScreenshotBoard active />);
	const choose = screen.getByRole("button", { name: "Choose screenshots" });
	await waitFor(() => expect(choose).toBeEnabled());
	if (mode === "automatic import") fireEvent.click(choose);
	else fireEvent.click(await screen.findByRole("button", { name: "Analyze screenshots" }));
	fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
	expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	expect(nativeBridgeClient.screenshotIntel.cancel).not.toHaveBeenCalled();
	await act(async () => releaseSave?.());
	await screen.findByText("Analysis cancelled");
	expect(nativeBridgeClient.screenshotIntel.analyze).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "Browse 4 screens" })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	const retry = screen.getByRole("button", { name: "Analyze screenshots" });
	expect(retry).toBeEnabled();
	fireEvent.click(retry);
	await screen.findByText("Setup uses focused choices.");
	expect(nativeBridgeClient.screenshotIntel.analyze).toHaveBeenCalledExactlyOnceWith(batch.id);
	expect(nativeBridgeClient.screenshotIntel.pick).toHaveBeenCalledTimes(
		mode === "automatic import" ? 1 : 0,
	);
});

describe("compact visual product groups", () => {
	it("shows accurate group counts and opens the entire selected group on its first page", async () => {
		await loadBrief(bulk);
		const overview = screen.getByRole("region", { name: "Screen groups" });
		expect(within(overview).getByText("2 groups")).toBeVisible();
		expect(within(overview).getByRole("img", { name: "Screen 1" })).toBeVisible();
		expect(within(overview).getByRole("img", { name: "Screen 61" })).toBeVisible();
		expect(within(overview).queryByText("Review a product screen")).not.toBeInTheDocument();
		fireEvent.click(
			within(overview).getByRole("button", { name: "Browse Workspace · 60 screens" }),
		);
		expect(screen.getByLabelText("Screen group")).toHaveValue("Workspace");
		expect(screen.getByText("60 of 120")).toBeVisible();
		expect(screen.getByText("Page 1 of 3")).toBeVisible();
		expect(screen.getByRole("button", { name: "View Screen 61" })).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		fireEvent.click(screen.getByRole("button", { name: "Browse Setup · 60 screens" }));
		expect(screen.getByText("Page 1 of 3")).toBeVisible();
		expect(screen.getByRole("button", { name: "View Screen 1" })).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Browse 120 screens" }));
		expect(screen.queryByRole("region", { name: "Screenshot library" })).not.toBeInTheDocument();
		expect(within(overview).getAllByRole("img")).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Browse 120 screens" }));
		expect(screen.getByLabelText("Screen group")).toHaveValue("");
		expect(screen.getByText("120 of 120")).toBeVisible();
		expect(screen.getByText("Page 1 of 5")).toBeVisible();
	});
	it("caps the overview at four representative thumbnails while reporting every group", async () => {
		await loadBrief({
			...brief,
			images: bulk.images.slice(0, 6),
			analysis: {
				...brief.analysis!,
				screens: bulk
					.analysis!.screens.slice(0, 6)
					.map((item, index) => ({ ...item, group: `Flow ${index + 1}` })),
			},
		});
		const overview = screen.getByRole("region", { name: "Screen groups" });
		expect(within(overview).getByText("6 groups")).toBeVisible();
		expect(within(overview).getAllByRole("img")).toHaveLength(4);
		expect(
			within(overview).queryByRole("button", { name: "Browse Flow 5 · 1 screen" }),
		).not.toBeInTheDocument();
		await browseScreens();
		expect(screen.getByRole("region", { name: "Flow 6" })).toBeVisible();
	});
	it("leaves unanalyzed screenshots uncategorized until a real report is available", async () => {
		vi.mocked(nativeBridgeClient.screenshotIntel.list).mockResolvedValue([batch]);
		render(<ScreenshotBoard active />);
		await screen.findByRole("button", { name: "Browse 4 screens" });
		expect(screen.queryByRole("region", { name: "Screen groups" })).not.toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});
	it("uses thumbnails for group and gallery previews but opens the full source in the inspector", async () => {
		await loadBrief({
			...brief,
			images: brief.images.map((image) => ({
				...image,
				thumbnailPath: `/Users/test/thumbs/${image.id}.jpg`,
			})),
		});
		const overview = screen.getByRole("region", { name: "Screen groups" });
		expect(within(overview).getByRole("img", { name: "AI name 1" })).toHaveAttribute(
			"src",
			expect.stringContaining("/thumbs/"),
		);
		await browseScreens();
		const card = screen.getByRole("button", { name: "View AI name 1" });
		expect(within(card).getByRole("img")).toHaveAttribute(
			"src",
			expect.stringContaining("/thumbs/"),
		);
		expect(
			within(card).getByText("Review requested permissions before choosing access."),
		).toBeVisible();
		fireEvent.click(card);
		expect(
			within(screen.getByRole("dialog")).getByRole("img", { name: "AI name 1" }),
		).toHaveAttribute("src", expect.stringContaining("Capture%201.png"));
	});
	it("shows one finding per column and reveals all remaining findings together", async () => {
		const strength = brief.analysis!.readout!.strengths[0];
		const friction = brief.analysis!.readout!.frictions[0];
		const extra = {
			...brief,
			analysis: {
				...brief.analysis!,
				readout: {
					strengths: [strength, { ...strength, title: "Clear hierarchy" }],
					frictions: [
						friction,
						{ ...friction, title: "Missing recovery" },
						{ ...friction, title: "Hidden access" },
					],
				},
			},
		};
		await loadBrief(extra);
		expect(screen.getByText("Focused choices")).toBeVisible();
		expect(screen.getByText("Unclear permission scope")).toBeVisible();
		expect(screen.queryByText("Clear hierarchy")).not.toBeInTheDocument();
		expect(screen.queryByText("Missing recovery")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "More findings (3)" }));
		expect(screen.getByText("Clear hierarchy")).toBeVisible();
		expect(screen.getByText("Hidden access")).toBeVisible();
		expect(screen.getByRole("button", { name: "Fewer findings" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		fireEvent.click(screen.getByRole("button", { name: "Fewer findings" }));
		expect(screen.queryByText("Clear hierarchy")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "More findings (3)" }));
		vi.mocked(nativeBridgeClient.screenshotIntel.analyze).mockResolvedValue(extra);
		openMore();
		fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Analyze again" })).toBeEnabled(),
		);
		expect(screen.queryByText("Clear hierarchy")).not.toBeInTheDocument();
	});
});
