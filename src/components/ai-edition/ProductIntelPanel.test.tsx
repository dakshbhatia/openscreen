// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompanyDomain } from "@/lib/company-context";
import { DEFAULT_INTEL_SETTINGS, type IntelReport, type IntelSettings } from "@/lib/product-intel";
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

function deferred<T>() {
	let complete: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		complete = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			complete?.(value);
		},
	};
}

describe("ProductIntelPanel", () => {
	it("does not overwrite newer brief edits when an older domain blur save completes", async () => {
		const save = deferred<IntelSettings>();
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockReturnValueOnce(save.promise);
		panel();
		await waitFor(() => expect(screen.getByLabelText("Our product")).toBeEnabled());
		fireEvent.click(screen.getByText("Research settings", { selector: "summary" }));
		fireEvent.change(screen.getByLabelText("Company domain (optional)"), {
			target: { value: "example.com" },
		});
		fireEvent.blur(screen.getByLabelText("Company domain (optional)"));
		const newerBrief = "My newer words!\n  Preserve this spacing.";
		fireEvent.change(screen.getByLabelText("Our product"), { target: { value: newerBrief } });
		await act(async () =>
			save.resolve({ ...DEFAULT_INTEL_SETTINGS, companyDomain: "https://example.com" }),
		);
		expect(screen.getByLabelText("Our product")).toHaveValue(newerBrief);
		fireEvent.blur(screen.getByLabelText("Our product"));
		await waitFor(() =>
			expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenLastCalledWith(
				expect.objectContaining({ productBrief: newerBrief }),
			),
		);
	});
	it("does not load an old snapshot that began while local settings were saving", async () => {
		const save = deferred<IntelSettings>();
		const snapshot =
			deferred<Awaited<ReturnType<typeof nativeBridgeClient.productIntel.snapshot>>>();
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockReturnValueOnce(save.promise);
		vi.mocked(nativeBridgeClient.productIntel.snapshot)
			.mockResolvedValueOnce({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: null,
			})
			.mockReturnValueOnce(snapshot.promise);
		const view = panel();
		await waitFor(() => expect(screen.getByLabelText("Our product")).toBeEnabled());
		fireEvent.change(screen.getByLabelText("Our product"), {
			target: { value: "Keep my local brief" },
		});
		fireEvent.change(screen.getByLabelText("Company domain (optional)"), {
			target: { value: "example.com" },
		});
		fireEvent.blur(screen.getByLabelText("Company domain (optional)"));
		const props = {
			onOpenChange: vi.fn(),
			projectId: "proj_1",
			source,
			freshRecordingProjectId: null,
		};
		view.rerender(<ProductIntelPanel {...props} open={false} />);
		view.rerender(<ProductIntelPanel {...props} open />);
		await waitFor(() => expect(nativeBridgeClient.productIntel.snapshot).toHaveBeenCalledTimes(2));
		await act(async () =>
			save.resolve({
				...DEFAULT_INTEL_SETTINGS,
				productBrief: "Keep my local brief",
				companyDomain: "https://example.com",
			}),
		);
		await act(async () =>
			snapshot.resolve({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: null,
			}),
		);
		expect(screen.getByLabelText("Our product")).toHaveValue("Keep my local brief");
		expect(screen.getByLabelText("Company domain (optional)")).toHaveValue("https://example.com");
	});
	it("ignores a save completion from the previously open project", async () => {
		const save = deferred<IntelSettings>();
		const nextSettings = {
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "Second project words",
			companyDomain: "https://other.com",
		};
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockReturnValueOnce(save.promise);
		vi.mocked(nativeBridgeClient.productIntel.snapshot)
			.mockResolvedValueOnce({
				settings: DEFAULT_INTEL_SETTINGS,
				report: null,
				connected: true,
				status: null,
			})
			.mockResolvedValueOnce({
				settings: nextSettings,
				report: null,
				connected: true,
				status: null,
			});
		const view = panel();
		await waitFor(() => expect(screen.getByLabelText("Our product")).toBeEnabled());
		fireEvent.change(screen.getByLabelText("Company domain (optional)"), {
			target: { value: "example.com" },
		});
		fireEvent.blur(screen.getByLabelText("Company domain (optional)"));
		view.rerender(
			<ProductIntelPanel
				open
				onOpenChange={vi.fn()}
				projectId="proj_2"
				source={{ ...source, assetId: "asset_2" }}
				freshRecordingProjectId={null}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByLabelText("Our product")).toHaveValue("Second project words"),
		);
		await act(async () =>
			save.resolve({ ...DEFAULT_INTEL_SETTINGS, companyDomain: "https://example.com" }),
		);
		expect(screen.getByLabelText("Our product")).toHaveValue("Second project words");
		expect(screen.getByLabelText("Company domain (optional)")).toHaveValue("https://other.com");
	});
	it("preserves explicit checkbox next-values across a delayed save", async () => {
		const save = deferred<IntelSettings>();
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockReturnValueOnce(save.promise);
		panel(true);
		await waitFor(() => expect(screen.getByLabelText("Our product")).toBeEnabled());
		fireEvent.click(screen.getByText("Research settings", { selector: "summary" }));
		fireEvent.click(screen.getByRole("checkbox"));
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ autoAnalyze: true }),
		);
		expect(screen.getByRole("checkbox")).toBeChecked();
		expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
		await act(async () => save.resolve({ ...DEFAULT_INTEL_SETTINGS, autoAnalyze: true }));
		expect(screen.getByRole("checkbox")).toBeChecked();
		await waitFor(() => expect(nativeBridgeClient.productIntel.analyze).toHaveBeenCalledTimes(1));
	});
	it("keeps optional company domain inside Research settings and preserves the brief", async () => {
		const brief = "My quirky brief!\n  Keep these spaces.";
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: { ...DEFAULT_INTEL_SETTINGS, productBrief: brief },
			report: null,
			connected: true,
			status: null,
		});
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockImplementation(
			async (settings) => ({
				...settings,
				companyDomain: normalizeCompanyDomain(settings.companyDomain),
			}),
		);
		panel();
		await waitFor(() => expect(screen.getByLabelText("Our product")).toHaveValue(brief));
		expect(screen.getByLabelText("Company domain (optional)")).not.toBeVisible();
		fireEvent.click(screen.getByText("Research settings", { selector: "summary" }));
		const domain = screen.getByLabelText("Company domain (optional)");
		expect(domain).toBeVisible();
		fireEvent.change(domain, { target: { value: "example.com/about" } });
		fireEvent.blur(domain);
		await waitFor(() => expect(domain).toHaveValue("https://example.com"));
		expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
			expect.objectContaining({ companyDomain: "example.com/about", productBrief: brief }),
		);
		expect(screen.getByLabelText("Our product")).toHaveValue(brief);
	});
	it("marks domain changes stale and renders only verified company sources", async () => {
		const settings = { ...DEFAULT_INTEL_SETTINGS, companyDomain: "https://example.com" };
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings,
			report: {
				...report,
				settings,
				companyContext: {
					domain: "https://example.com",
					status: "retrieved",
					sourceUrls: ["https://www.example.com/about"],
				},
			},
			connected: true,
			status: null,
		});
		panel();
		const sourceLink = await screen.findByRole("link", { name: "www.example.com" });
		expect(sourceLink).toHaveAttribute("href", "https://www.example.com/about");
		expect(screen.getByText(/Company website retrieved/)).toBeVisible();
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Company domain (optional)"), {
			target: { value: "https://other.com" },
		});
		expect(screen.getByRole("note")).toHaveTextContent("Context changed");
	});
	it("shows unavailable website context when an older report has a domain without retrieval metadata", async () => {
		const settings = { ...DEFAULT_INTEL_SETTINGS, companyDomain: "https://example.com" };
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings,
			report: { ...report, settings },
			connected: true,
			status: null,
		});
		panel();
		expect(await screen.findByText(/Company website unavailable/)).toBeVisible();
		expect(screen.queryByText(/Company website retrieved/)).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "example.com" })).not.toBeInTheDocument();
	});
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
	it("prioritizes one legacy finding and preserves collapsed reasoning and remaining evidence", async () => {
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
		expect(screen.getByText("Observation 3")).not.toBeVisible();
		expect(screen.getByText("Observation 4")).not.toBeVisible();
		expect(screen.getByText("Hypothesis 1")).not.toBeVisible();
		fireEvent.click(screen.getAllByText("Hypothesis", { selector: "summary" })[0]);
		expect(screen.getByText("Hypothesis 1")).toBeVisible();
		fireEvent.click(screen.getByText("More findings (3)"));
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
		await screen.findByText("A sample board appears");
		fireEvent.click(screen.getByLabelText("More report actions"));
		fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ type: "text/markdown;charset=utf-8" }),
		);
		expect(click.mock.instances[0]).toHaveAttribute("download", "product-flow-proj_1.md");
		click.mockRestore();
		vi.unstubAllGlobals();
	});
	it("exports allowlisted JSON with company domain and provider retrieval metadata", async () => {
		const settings = {
			...DEFAULT_INTEL_SETTINGS,
			companyDomain: "https://example.com",
			productBrief: "My exact brief!\n  Keep this spacing.",
		};
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings,
			report: {
				...report,
				settings,
				companyContext: {
					domain: "https://example.com",
					status: "retrieved",
					sourceUrls: ["https://example.com/about"],
				},
			},
			connected: true,
			status: null,
		});
		const blobs: Blob[] = [];
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL = vi.fn((blob: Blob) => {
					blobs.push(blob);
					return "blob:test-json";
				});
				static revokeObjectURL = vi.fn();
			},
		);
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
			/* Prevent jsdom navigation. */
		});
		panel();
		await screen.findByText("A sample board appears");
		fireEvent.click(screen.getByLabelText("More report actions"));
		fireEvent.click(screen.getByRole("button", { name: "JSON" }));
		expect(blobs[0].type).toBe("application/json");
		const content = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsText(blobs[0]);
		});
		expect(content).toContain('"companyDomain": "https://example.com"');
		expect(content).toContain('"status": "retrieved"');
		expect(content).toContain("https://example.com/about");
		expect(JSON.parse(content).context.productBrief).toBe(settings.productBrief);
		expect(content).not.toContain("systemPrompt");
		expect(content).not.toContain("/tmp/flow.mp4");
	});
});

const recordingBrief: IntelReport = {
	...report,
	analysis: {
		...report.analysis,
		understanding: {
			product: "A project planning workspace",
			audience: "Small delivery teams (inferred)",
			job: "Turn a plan into assigned work",
			confidence: "medium",
		},
		readout: {
			strengths: [
				{
					title: "Focused setup",
					reason: "Setup asks for one decision at a time",
					basis: "observed",
					confidence: "high",
					evidenceTimesSec: [2, 8],
				},
				{
					title: "Clear progress",
					reason: "The next action remains visible",
					basis: "observed",
					confidence: "medium",
					evidenceTimesSec: [4],
				},
			],
			frictions: [
				{
					title: "Unclear access scope",
					reason: "The permissions effect is not visible",
					basis: "inferred",
					confidence: "low",
					evidenceTimesSec: [3],
				},
				{
					title: "Hidden recovery",
					reason: "A recovery route is not shown",
					basis: "inferred",
					confidence: "low",
					evidenceTimesSec: [5],
				},
			],
		},
		decisions: [
			{
				title: "Test a focused first step",
				recommendation: "adapt",
				rationale: "Fits our stated need for quick setup",
				counterEvidence: "Frequent users might want every field",
				experiment: "Compare setup errors with fewer fields",
				tradeoff: "An extra step can slow expert users",
				confidence: "medium",
				evidenceTimesSec: [2, 8],
			},
			{
				title: "Investigate recovery",
				recommendation: "investigate",
				rationale: "Recovery is not shown",
				counterEvidence: "Another route may exist",
				experiment: "Check the failed-save route",
				tradeoff: "Investigation takes time",
				confidence: "low",
				evidenceTimesSec: [5],
			},
		],
		pieces: Array.from({ length: 5 }, (_, index) => ({
			name: ["Onboarding", "Workspace", "Sharing", "Settings", "Recovery"][index],
			purpose: `Purpose of product piece ${index + 1}`,
			timeSec: index + 1,
		})),
		findings: [
			{
				timeSec: 2,
				category: "activation",
				observation: "Legacy fallback observation",
				hypothesis: "Legacy fallback hypothesis",
				implication: "Legacy fallback implication",
				confidence: "medium",
			},
		],
	},
};
async function loadRecordingBrief(next = recordingBrief) {
	vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
		settings: next.settings,
		report: next,
		connected: true,
		status: null,
	});
	panel();
	await screen.findByRole("heading", { name: "Product brief" });
}

describe("recording Product brief", () => {
	it("hides all setup and preserves exact context words when editing inside Research settings", async () => {
		const words = "My quirky brief!\n  Keep these spaces.";
		vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
			settings: { ...DEFAULT_INTEL_SETTINGS, productBrief: words },
			report: null,
			connected: true,
			status: null,
		});
		panel();
		await waitFor(() => expect(screen.getByLabelText("Our product")).toHaveValue(words));
		expect(screen.getByLabelText("Our product")).not.toBeVisible();
		expect(screen.getByLabelText("Company domain (optional)")).not.toBeVisible();
		expect(screen.getByLabelText("Gemini API key")).not.toBeVisible();
		expect(screen.getByLabelText("Focus")).not.toBeVisible();
		expect(screen.getByLabelText("Model")).not.toBeVisible();
		expect(
			screen.queryByText("Add your product context to make the takeaways relevant."),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByText("Research settings", { selector: "summary" }));
		expect(screen.getByLabelText("Our product")).toBeVisible();
		fireEvent.blur(screen.getByLabelText("Our product"));
		await waitFor(() =>
			expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenCalledWith(
				expect.objectContaining({ productBrief: words }),
			),
		);
	});
	it("shows product, job, one strength, one friction and one next step with deeper reasoning hidden", async () => {
		await loadRecordingBrief();
		expect(screen.getByText("A project planning workspace")).toBeVisible();
		expect(screen.getByText("Turn a plan into assigned work")).toBeVisible();
		expect(
			screen.getByText("Small delivery teams (inferred) · medium confidence"),
		).not.toBeVisible();
		expect(screen.getByText("Focused setup")).toBeVisible();
		expect(screen.getByText("Unclear access scope")).toBeVisible();
		expect(screen.queryByText("Clear progress")).not.toBeInTheDocument();
		expect(screen.queryByText("Hidden recovery")).not.toBeInTheDocument();
		expect(screen.getByText("Test a focused first step")).toBeVisible();
		expect(screen.queryByText("Investigate recovery")).not.toBeInTheDocument();
		expect(screen.getByText("Fits our stated need for quick setup")).not.toBeVisible();
		expect(screen.getByText("A sample board appears")).not.toBeVisible();
		expect(screen.queryByText("Legacy fallback observation")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Source recording")).not.toBeInTheDocument();
		expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "More findings (2)" }));
		expect(screen.getByText("Clear progress")).toBeVisible();
		expect(screen.getByText("Hidden recovery")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "More decisions (1)" }));
		expect(screen.getByText("Investigate recovery")).toBeVisible();
		fireEvent.click(screen.getByText("Audience & confidence", { selector: "summary" }));
		expect(screen.getByText("Small delivery teams (inferred) · medium confidence")).toBeVisible();
	});
	it("uses four named purpose cards and opens their real timestamp without invented images", async () => {
		await loadRecordingBrief();
		const pieces = screen.getByRole("region", { name: "Product pieces" });
		expect(within(pieces).getAllByRole("button", { name: /^View / })).toHaveLength(4);
		expect(within(pieces).getByText("Purpose of product piece 1")).toBeVisible();
		expect(within(pieces).queryByText("Recovery")).not.toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		fireEvent.click(within(pieces).getByRole("button", { name: "View Sharing at 00:03" }));
		const recording = screen.getByLabelText("Source recording") as HTMLVideoElement;
		recording.scrollIntoView = vi.fn();
		fireEvent.loadedMetadata(recording);
		expect(recording.currentTime).toBe(3);
		expect(recording.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
		expect(recording).toHaveAttribute("src", expect.stringContaining("flow.mp4"));
		fireEvent.click(screen.getByRole("button", { name: "Hide recording" }));
		expect(screen.queryByLabelText("Source recording")).not.toBeInTheDocument();
	});
	it("opens each cited time while secondary citations stay disclosed", async () => {
		await loadRecordingBrief();
		const strength = screen.getByRole("region", { name: "Works well" });
		expect(
			within(strength).getByRole("button", { name: "Evidence for Focused setup at 00:02" }),
		).toBeVisible();
		expect(
			within(strength).getByRole("button", { name: "Evidence for Focused setup at 00:08" }),
		).not.toBeVisible();
		fireEvent.click(
			within(strength).getByRole("button", { name: "Evidence for Focused setup at 00:02" }),
		);
		const recording = screen.getByLabelText("Source recording") as HTMLVideoElement;
		fireEvent.loadedMetadata(recording);
		expect(recording.currentTime).toBe(2);
		fireEvent.click(within(strength).getByText("More evidence (1)", { selector: "summary" }));
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
			/* Media is stubbed in jsdom. */
		});
		fireEvent.click(
			within(strength).getByRole("button", { name: "Evidence for Focused setup at 00:08" }),
		);
		expect(recording.currentTime).toBe(8);
	});
	it("keeps unsupported sections empty instead of inventing findings or recommendations", async () => {
		await loadRecordingBrief({
			...recordingBrief,
			analysis: {
				...recordingBrief.analysis,
				readout: { strengths: [], frictions: [] },
				decisions: [],
				pieces: [],
			},
		});
		expect(screen.getByText("No supported strengths in this recording.")).toBeVisible();
		expect(screen.getByText("No supported friction in this recording.")).toBeVisible();
		expect(screen.getByText("No supported product decision yet.")).toBeVisible();
		expect(screen.queryByRole("region", { name: "Product pieces" })).not.toBeInTheDocument();
		expect(screen.queryByText("Legacy fallback observation")).not.toBeInTheDocument();
	});
	it("cancels during settings preparation before upload and permits a retry", async () => {
		const save = deferred<IntelSettings>();
		vi.mocked(nativeBridgeClient.productIntel.saveSettings).mockReturnValueOnce(save.promise);
		panel();
		const analyze = screen.getByRole("button", { name: "Analyze flow" });
		await waitFor(() => expect(analyze).toBeEnabled());
		fireEvent.click(analyze);
		fireEvent.click(await screen.findByRole("button", { name: "Cancel analysis" }));
		expect(nativeBridgeClient.productIntel.cancel).not.toHaveBeenCalled();
		await act(async () => save.resolve(DEFAULT_INTEL_SETTINGS));
		await screen.findByText("Analysis cancelled");
		expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Analyze flow" }));
		await screen.findByText("A sample board appears");
		expect(nativeBridgeClient.productIntel.analyze).toHaveBeenCalledExactlyOnceWith(
			"proj_1",
			false,
		);
	});
});

it("does not re-upload a saved legacy report even when a fresh-recording marker and automation remain", async () => {
	vi.mocked(nativeBridgeClient.productIntel.snapshot).mockResolvedValue({
		settings: { ...DEFAULT_INTEL_SETTINGS, autoAnalyze: true },
		report,
		connected: true,
		status: null,
	});
	panel(true);
	await screen.findByText("A sample board appears");
	expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
	expect(nativeBridgeClient.productIntel.saveSettings).not.toHaveBeenCalled();
});

it("puts product pieces before the PM readout and discloses every remaining purpose and timestamp", async () => {
	await loadRecordingBrief();
	const pieces = screen.getByRole("region", { name: "Product pieces" });
	const readout = screen.getByRole("region", { name: "Works well" });
	expect(pieces.compareDocumentPosition(readout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	const more = within(pieces).getByRole("button", { name: "More pieces (1)" });
	expect(more).toHaveAttribute("aria-expanded", "false");
	expect(more).toHaveAttribute("aria-controls", "recording-product-pieces");
	expect(within(pieces).queryByText("Purpose of product piece 5")).not.toBeInTheDocument();
	fireEvent.click(more);
	expect(within(pieces).getAllByRole("button", { name: /^View / })).toHaveLength(5);
	expect(within(pieces).getByText("Purpose of product piece 5")).toBeVisible();
	fireEvent.click(within(pieces).getByRole("button", { name: "View Recovery at 00:05" }));
	const recording = screen.getByLabelText("Source recording") as HTMLVideoElement;
	fireEvent.loadedMetadata(recording);
	expect(recording.currentTime).toBe(5);
	fireEvent.click(within(pieces).getByRole("button", { name: "Fewer pieces" }));
	expect(
		within(pieces).queryByRole("button", { name: "View Recovery at 00:05" }),
	).not.toBeInTheDocument();
	expect(within(pieces).getByRole("button", { name: "More pieces (1)" })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
});
it("keeps exports and reanalysis hidden under report More until explicitly requested", async () => {
	await loadRecordingBrief();
	for (const name of ["Markdown", "JSON", "Analyze flow"])
		expect(screen.getByRole("button", { name })).not.toBeVisible();
	expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
	fireEvent.click(screen.getByLabelText("More report actions"));
	for (const name of ["Markdown", "JSON", "Analyze flow"])
		expect(screen.getByRole("button", { name })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Analyze flow" }));
	await waitFor(() =>
		expect(nativeBridgeClient.productIntel.analyze).toHaveBeenCalledExactlyOnceWith(
			"proj_1",
			false,
		),
	);
});

it("keeps modern summary and research diagnostics inside More while preserving full text and verified sources", async () => {
	const summary = "Exact saved recording summary. ".repeat(15).trim();
	await loadRecordingBrief({
		...recordingBrief,
		analysis: { ...recordingBrief.analysis, summary },
		settings: { ...DEFAULT_INTEL_SETTINGS, companyDomain: "https://example.com" },
		companyContext: {
			domain: "https://example.com",
			status: "retrieved",
			sourceUrls: ["https://example.com/about"],
		},
	});
	expect(screen.getByText("Full summary", { selector: "summary" })).not.toBeVisible();
	expect(screen.getByText("Research details", { selector: "summary" })).not.toBeVisible();
	expect(screen.getByText(summary)).not.toBeVisible();
	expect(screen.getByText("example.com", { selector: "a" })).not.toBeVisible();
	fireEvent.click(screen.getByLabelText("More report actions"));
	expect(screen.getByText("Full summary", { selector: "summary" })).toBeVisible();
	expect(screen.getByText(summary)).not.toBeVisible();
	fireEvent.click(screen.getByText("Full summary", { selector: "summary" }));
	expect(screen.getByText(summary)).toBeVisible();
	fireEvent.click(screen.getByText("Research details", { selector: "summary" }));
	expect(screen.getByRole("link", { name: "example.com" })).toBeVisible();
	expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute(
		"href",
		"https://example.com/about",
	);
	expect(screen.getByText(/Company website retrieved/)).toBeVisible();
	expect(nativeBridgeClient.productIntel.analyze).not.toHaveBeenCalled();
});

const journeyBrief: IntelReport = {
	...recordingBrief,
	analysis: {
		...recordingBrief.analysis,
		journey: {
			goal: "Understand how a team reaches its first shared project",
			goalBasis: "inferred",
			coverage: "partial",
			outcome: "A project is visible; a teammate accepting the invitation is not shown.",
			stages: [
				{
					name: "Create project",
					purpose: "Give the team a shared place to organize work.",
					evidenceTimesSec: [2],
				},
				{
					name: "Invite teammate",
					purpose: "Bring another person into the shared work.",
					evidenceTimesSec: [4, 8],
				},
			],
		},
	},
};

describe("recording goal and journey", () => {
	it("shows one compact goal while stages, the duplicate job and legacy steps stay hidden", async () => {
		await loadRecordingBrief(journeyBrief);
		expect(screen.getByText(journeyBrief.analysis.journey?.goal ?? "")).toBeVisible();
		expect(screen.getByText("Inferred from recording")).toBeVisible();
		expect(screen.getByText("Turn a plan into assigned work")).not.toBeVisible();
		expect(screen.getByText("Give the team a shared place to organize work.")).not.toBeVisible();
		expect(screen.getByText(journeyBrief.analysis.journey?.outcome ?? "")).not.toBeVisible();
		const explore = screen.getByText("Explore journey", { selector: "summary" });
		expect(explore).toBeVisible();
		expect(explore.parentElement).not.toHaveAttribute("open");
		expect(screen.getByText("The journey (1 step)")).not.toBeVisible();
		expect(screen.getByText("Focused setup")).toBeVisible();
		expect(screen.getByText("Unclear access scope")).toBeVisible();
		expect(screen.getByText("Test a focused first step")).toBeVisible();
		expect(screen.queryByText("Clear progress")).not.toBeInTheDocument();
		expect(screen.queryByText("Hidden recovery")).not.toBeInTheDocument();
		expect(screen.queryByText("Investigate recovery")).not.toBeInTheDocument();
	});

	it("discloses partial coverage, purposes and outcome, and seeks each stage citation", async () => {
		await loadRecordingBrief(journeyBrief);
		fireEvent.click(screen.getByText("Explore journey", { selector: "summary" }));
		expect(
			screen.getByText("Partial recording. Task stages before or after this clip may be missing."),
		).toBeVisible();
		expect(screen.getByText("Bring another person into the shared work.")).toBeVisible();
		expect(screen.getByText(journeyBrief.analysis.journey?.outcome ?? "")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Evidence for Create project at 00:02" }));
		const recording = screen.getByLabelText("Source recording") as HTMLVideoElement;
		fireEvent.loadedMetadata(recording);
		expect(recording.currentTime).toBe(2);
		const invite = screen.getByRole("heading", { name: "Invite teammate" }).closest("li");
		expect(invite).not.toBeNull();
		if (!invite) throw new Error("Stage is missing");
		const extra = within(invite).getByRole("button", {
			name: "Evidence for Invite teammate at 00:08",
		});
		expect(extra).not.toBeVisible();
		fireEvent.click(within(invite).getByText("More evidence (1)", { selector: "summary" }));
		expect(extra).toBeVisible();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
		fireEvent.click(extra);
		expect(recording.currentTime).toBe(8);
	});

	it.each([
		["supplied", "Supplied"],
		["unknown", "Unknown"],
	] as const)("labels %s goals and bounds complete coverage to the visible task", async (goalBasis, label) => {
		const journey = journeyBrief.analysis.journey;
		if (!journey) throw new Error("Journey fixture is missing");
		await loadRecordingBrief({
			...journeyBrief,
			analysis: {
				...journeyBrief.analysis,
				journey: { ...journey, goalBasis, coverage: "complete" },
			},
		});
		expect(screen.getByText(label, { selector: "small" })).toBeVisible();
		fireEvent.click(screen.getByText("Explore journey", { selector: "summary" }));
		expect(
			screen.getByText(
				"Complete visible task in this recording. This does not establish the whole product journey.",
			),
		).toBeVisible();
	});

	it("saves the optional research goal verbatim, separate from the attempted flow, and marks stale context", async () => {
		const next = {
			...journeyBrief,
			settings: {
				...DEFAULT_INTEL_SETTINGS,
				task: "Attempt to invite a teammate",
				productBrief: "My unchanged product words",
			},
		};
		await loadRecordingBrief(next);
		const goal = screen.getByLabelText("What are you trying to learn?");
		expect(goal).not.toBeVisible();
		expect(goal).toHaveValue("");
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		fireEvent.click(screen.getByText("Research settings", { selector: "summary" }));
		const words = "  Why does this setup feel slow?\nKeep my exact wording!  ";
		fireEvent.change(goal, { target: { value: words } });
		expect(screen.getByRole("note")).toHaveTextContent("Context changed");
		fireEvent.blur(goal);
		await waitFor(() =>
			expect(nativeBridgeClient.productIntel.saveSettings).toHaveBeenLastCalledWith(
				expect.objectContaining({
					researchGoal: words,
					task: next.settings.task,
					productBrief: next.settings.productBrief,
				}),
			),
		);
		expect(goal).toHaveValue(words);
		fireEvent.change(goal, { target: { value: "" } });
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});

	it("keeps legacy job context and timestamped steps available without inventing a journey", async () => {
		await loadRecordingBrief();
		expect(screen.getByText("Turn a plan into assigned work")).toBeVisible();
		expect(screen.queryByText("Explore journey")).not.toBeInTheDocument();
		expect(screen.getByText("The journey (1 step)")).not.toBeVisible();
		fireEvent.click(screen.getByLabelText("More report actions"));
		fireEvent.click(screen.getByText("Research details", { selector: "summary" }));
		fireEvent.click(screen.getByText("The journey (1 step)", { selector: "summary" }));
		fireEvent.click(screen.getByRole("button", { name: /00:03.*Open board/ }));
		const recording = screen.getByLabelText("Source recording") as HTMLVideoElement;
		fireEvent.loadedMetadata(recording);
		expect(recording.currentTime).toBe(3);
	});
});
