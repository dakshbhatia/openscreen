// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
		fireEvent.click(await screen.findByRole("button", { name: "JSON" }));
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
