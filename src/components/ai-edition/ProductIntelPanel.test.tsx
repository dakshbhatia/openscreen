// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTEL_SETTINGS, type IntelReport } from "@/lib/product-intel";
import { nativeBridgeClient } from "@/native/client";
import { ProductIntelPanel } from "./ProductIntelPanel";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		productIntel: { snapshot: vi.fn(), saveSettings: vi.fn(), analyze: vi.fn(), cancel: vi.fn() },
		aiEdition: { llmSetApiKey: vi.fn() },
	},
}));
const source = { assetId: "asset_1", path: "/tmp/flow.mp4", durationSec: 10 };
const report: IntelReport = {
	projectId: "proj_1",
	assetId: "asset_1",
	durationSec: 10,
	createdAt: "2026-10-08T12:00:00Z",
	settings: DEFAULT_INTEL_SETTINGS,
	sourceFingerprint: "abc",
	remoteFileDeleted: true,
	analysis: {
		summary: "A sample board appears",
		steps: [{ timeSec: 3, action: "Open board", evidence: "A sample board is visible" }],
		findings: [],
		unknowns: ["Retention is unknown"],
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
		settings: DEFAULT_INTEL_SETTINGS,
		report: null,
		connected: true,
		status: null,
	});
	vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockImplementation(async (s) => s);
	vi.mocked(nativeBridgeClient.productIntel.analyze).mockResolvedValue(report);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function panel(fresh = false) {
	return render(
		<ProductIntelPanel
			open
			onOpenChange={() => {
				/* Controlled by the test. */
			}}
			projectId="proj_1"
			source={source}
			freshRecordingProjectId={fresh ? "proj_1" : null}
		/>,
	);
}

describe("ProductIntelPanel", () => {
	it("lets the user supply context and displays timestamped evidence", async () => {
		panel();
		await screen.findByLabelText("Our product");
		fireEvent.change(screen.getByLabelText("Our product"), {
			target: { value: "Tools for architects" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Analyze flow" }));
		await screen.findByText("A sample board appears");
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ productBrief: "Tools for architects" }),
		);
		fireEvent.click(screen.getByText("The journey (1 step)"));
		expect(screen.getByRole("button", { name: /00:03.*Open board/ })).toBeVisible();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
			/* Media is stubbed in jsdom. */
		});
		fireEvent.click(screen.getByRole("button", { name: /00:03.*Open board/ }));
		expect((screen.getByLabelText("Source recording") as HTMLVideoElement).currentTime).toBe(3);
	});
	it("does not analyze a restored project even with automation enabled", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: { ...DEFAULT_INTEL_SETTINGS, autoAnalyze: true },
			report: null,
			connected: true,
			status: null,
		});
		panel();
		await screen.findByLabelText("Our product");
		expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
	});
	it("automatically analyzes a fresh recording exactly once", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: { ...DEFAULT_INTEL_SETTINGS, autoAnalyze: true },
			report: null,
			connected: true,
			status: null,
		});
		const view = panel(true);
		await screen.findByText("A sample board appears");
		view.rerender(
			<ProductIntelPanel
				open
				onOpenChange={() => {
					/* Controlled by the test. */
				}}
				projectId="proj_1"
				source={{ ...source }}
				freshRecordingProjectId="proj_1"
			/>,
		);
		expect(nativeBridgeClient.productIntel.analyze).toHaveBeenCalledTimes(1);
	});
	it("shows an actionable error and allows retry when Gemini fails", async () => {
		vi.mocked(nativeBridgeClient.productIntel.analyze).mockRejectedValue(
			new Error("Gemini quota exceeded"),
		);
		panel();
		await screen.findByLabelText("Our product");
		fireEvent.click(screen.getByRole("button", { name: "Analyze flow" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Gemini quota exceeded"),
		);
		expect(screen.getByRole("button", { name: "Analyze flow" })).toBeEnabled();
	});
	it("keeps key setup hidden until Analyze reveals it and focuses the key field", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			report: null,
			connected: false,
			status: null,
		});
		vi.mocked(nativeBridgeClient.aiEdition.llmSetApiKey).mockResolvedValue({ success: true });
		panel();
		const analyze = await screen.findByRole("button", { name: "Analyze flow" });
		await waitFor(() => expect(analyze).toBeEnabled());
		expect(screen.getByLabelText("Gemini API key")).not.toBeVisible();
		expect(screen.queryByText("Connect Gemini to start")).not.toBeInTheDocument();
		expect(screen.getByText("Ready to analyze")).toBeVisible();
		fireEvent.click(analyze);
		expect(screen.getByLabelText("Gemini API key")).toBeVisible();
		expect(screen.getByLabelText("Gemini API key")).toHaveFocus();
		expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Gemini API key"), { target: { value: "test-key" } });
		fireEvent.click(screen.getByRole("button", { name: "Connect Gemini" }));
		await screen.findByText("Gemini key saved");
		expect(nativeBridgeClient.aiEdition.llmSetApiKey).toHaveBeenCalledWith("google", "test-key");
		expect(screen.getByLabelText("Gemini API key")).toHaveValue("");
	});
	it("keeps Analyze disabled without a recording even when the key is absent", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			report: null,
			connected: false,
			status: null,
		});
		render(
			<ProductIntelPanel
				open
				onOpenChange={vi.fn()}
				projectId={null}
				source={null}
				freshRecordingProjectId={null}
			/>,
		);
		await screen.findByText("Choose a recording");
		expect(screen.getByRole("button", { name: "Analyze flow" })).toBeDisabled();
		expect(screen.getByLabelText("Gemini API key")).not.toBeVisible();
	});

	it("renders inline without a dialog when embedded", async () => {
		render(
			<ProductIntelPanel
				embedded
				open
				onOpenChange={vi.fn()}
				projectId="proj_1"
				source={source}
				freshRecordingProjectId={null}
			/>,
		);
		await screen.findAllByText("Gemini key saved");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Product intelligence" })).toBeVisible();
	});
	it("marks takeaways as stale when their research context changes", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			report,
			connected: true,
			status: null,
		});
		panel();
		await screen.findByText("A sample board appears");
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Our product"), {
			target: { value: "Changed audience" },
		});
		expect(screen.getByRole("note")).toHaveTextContent("Context changed");
		fireEvent.change(screen.getByLabelText("Our product"), { target: { value: "" } });
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
	it("prioritizes three findings and preserves collapsed reasoning and remaining evidence", async () => {
		const findings: IntelReport["analysis"]["findings"] = Array.from({ length: 4 }, (_, index) => ({
			timeSec: index + 1,
			category: "activation",
			confidence: "medium",
			observation: `Observation ${index + 1}`,
			hypothesis: `Hypothesis ${index + 1}`,
			implication: `Implication ${index + 1}`,
		}));
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			report: { ...report, analysis: { ...report.analysis, findings } },
			connected: true,
			status: null,
		});
		panel();
		await screen.findByText("Observation 1");
		expect(screen.getByText("Observation 3")).toBeVisible();
		expect(screen.getByText("Observation 4")).not.toBeVisible();
		expect(screen.getByText("Hypothesis 1")).not.toBeVisible();
		fireEvent.click(screen.getAllByText("Hypothesis", { selector: "summary" })[0]);
		expect(screen.getByText("Hypothesis 1")).toBeVisible();
		fireEvent.click(screen.getByText("More findings (1)"));
		expect(screen.getByText("Observation 4")).toBeVisible();
	});
	it("reattaches to a running backend job and loads its final report", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot)
			.mockResolvedValueOnce({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: "Uploading recording",
			})
			.mockResolvedValue({
				settings: DEFAULT_INTEL_SETTINGS,
				report,
				connected: true,
				status: null,
			});
		panel();
		await screen.findByText("Uploading recording");
		expect(screen.getByRole("button", { name: "Analyzing…" })).toBeDisabled();
		expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
		await screen.findByText("A sample board appears", {}, { timeout: 2500 });
		expect(screen.getByRole("button", { name: "Analyze flow" })).toBeEnabled();
	});
	it("lets failed setup reload without reopening the panel", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot)
			.mockRejectedValueOnce(new Error("Could not read Gemini settings"))
			.mockResolvedValue({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: null,
			});
		panel();
		fireEvent.click(await screen.findByRole("button", { name: "Retry setup" }));
		await screen.findAllByText("Gemini key saved");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("does not show an old backend completion after switching projects", async () => {
		let finishOld:
			| ((value: Awaited<ReturnType<typeof nativeBridgeClient.productIntel.snapshot>>) => void)
			| undefined;
		vi.mocked(nativeBridgeClient.productIntel.snapshot)
			.mockResolvedValueOnce({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: "Uploading recording",
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOld = resolve;
					}),
			)
			.mockResolvedValue({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: null,
			});
		const view = panel();
		await screen.findByText("Uploading recording");
		await waitFor(() => expect(finishOld).toBeDefined(), { timeout: 2500 });
		view.rerender(
			<ProductIntelPanel
				open
				onOpenChange={vi.fn()}
				projectId="proj_2"
				source={{ ...source, assetId: "asset_2" }}
				freshRecordingProjectId={null}
			/>,
		);
		await screen.findByRole("button", { name: "Analyze flow" });
		finishOld?.({ settings: DEFAULT_INTEL_SETTINGS, report, connected: true, status: null });
		await waitFor(() => expect(screen.getByRole("button", { name: "Analyze flow" })).toBeEnabled());
		expect(screen.queryByText("A sample board appears")).not.toBeInTheDocument();
	});
	it("exports the visible report as Markdown", async () => {
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: DEFAULT_INTEL_SETTINGS,
			report,
			connected: true,
			status: null,
		});
		const create = vi.fn(() => "blob:test-report");
		const revoke = vi.fn();
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL = create;
				static revokeObjectURL = revoke;
			},
		);
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
			/* Prevent jsdom navigation. */
		});
		panel();
		fireEvent.click(await screen.findByRole("button", { name: "Markdown" }));
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ type: "text/markdown;charset=utf-8" }),
		);
		expect(click.mock.instances[0]).toHaveAttribute("download", "product-flow-proj_1.md");
		click.mockRestore();
		vi.unstubAllGlobals();
	});
});
