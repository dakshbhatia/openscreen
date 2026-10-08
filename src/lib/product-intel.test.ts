import { describe, expect, it } from "vitest";
import {
	buildProductPrompt,
	DEFAULT_INTEL_SETTINGS,
	intelReportSchema,
	intelSettingsSchema,
	PRODUCT_ANALYST_PROMPT,
	parseProductAnalysis,
} from "./product-intel";

const valid = {
	summary: "A workspace is created before inviting teammates.",
	steps: [{ timeSec: 2, action: "Create workspace", evidence: "The workspace form appears." }],
	findings: [
		{
			timeSec: 4,
			category: "activation",
			observation: "A sample board appears.",
			hypothesis: "Sample content may reduce setup effort.",
			implication: "Test a sample board for our audience.",
			confidence: "medium",
		},
	],
	unknowns: ["Conversion impact cannot be determined."],
};

describe("product intelligence evidence", () => {
	it("defaults the optional company domain for old settings without rewriting the brief or custom prompt", () => {
		const old = { productBrief: "My quirky brief!", systemPrompt: "Keep my custom lens." };
		const parsed = intelSettingsSchema.parse(old);
		expect(parsed.companyDomain).toBe("");
		expect(parsed.productBrief).toBe(old.productBrief);
		expect(parsed.systemPrompt).toBe(old.systemPrompt);
		expect(
			intelSettingsSchema.parse({ ...old, companyDomain: "example.com/about" }).companyDomain,
		).toBe("https://example.com");
		expect(() =>
			intelSettingsSchema.parse({ ...old, companyDomain: "http://localhost" }),
		).toThrow();
	});
	it("includes the optional domain as research data without claiming the website was visited", () => {
		const prompt = buildProductPrompt({
			...DEFAULT_INTEL_SETTINGS,
			companyDomain: "https://example.com",
		});
		expect(prompt).toContain('"companyDomain":"https://example.com"');
		expect(prompt).toContain("confirmed by URL tool retrieval");
		expect(prompt).toContain("does not establish that the website was visited");
	});
	it("keeps old reports compatible and accepts optional validated provider context", () => {
		const old = {
			projectId: "proj_1",
			assetId: "asset_1",
			createdAt: "2026-10-08T14:00:00Z",
			sourceFingerprint: "abc",
			durationSec: 10,
			settings: {},
			analysis: valid,
			remoteFileDeleted: true,
		};
		const parsed = intelReportSchema.parse(old);
		expect(parsed.settings.companyDomain).toBe("");
		expect(parsed).not.toHaveProperty("companyContext");
		expect(
			intelReportSchema.parse({
				...old,
				companyContext: {
					domain: "https://example.com",
					status: "retrieved",
					sourceUrls: ["https://example.com/"],
				},
			}).companyContext?.status,
		).toBe("retrieved");
		expect(() =>
			intelReportSchema.parse({
				...old,
				companyContext: {
					domain: "https://example.com",
					status: "retrieved",
					sourceUrls: ["https://other.com/"],
				},
			}),
		).toThrow();
	});
	it("carries the user's product brief and task verbatim into the analysis", () => {
		const prompt = buildProductPrompt({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "Tools for solo architects",
			competitor: "Example",
			task: "Create a project",
		});
		expect(prompt).toContain("Tools for solo architects");
		expect(prompt).toContain("Create a project");
	});
	it("rejects findings outside the source recording", () => {
		expect(() => parseProductAnalysis(valid, 3)).toThrow(/timestamp/i);
	});
	it("requires separate observation, hypothesis and implication", () => {
		const report = parseProductAnalysis(valid, 10);
		expect(report.findings[0].observation).toContain("sample board");
		expect(() =>
			parseProductAnalysis({ ...valid, findings: [{ timeSec: 4, category: "activation" }] }, 10),
		).toThrow();
	});
	it("preserves finding relevance order while putting journey steps in source order", () => {
		const analysis = parseProductAnalysis(
			{
				...valid,
				steps: [valid.steps[0], { timeSec: 1, action: "Open app", evidence: "Home appears." }],
				findings: [valid.findings[0], { ...valid.findings[0], timeSec: 1, confidence: "low" }],
			},
			10,
		);
		expect(analysis.steps.map((step) => step.timeSec)).toEqual([1, 2]);
		expect(analysis.findings.map((finding) => finding.timeSec)).toEqual([4, 1]);
	});
	it("asks for ranked contextual experiments and explicit uncertainty without invented lift", () => {
		expect(PRODUCT_ANALYST_PROMPT).toContain("Rank the findings array by relevance");
		expect(PRODUCT_ANALYST_PROMPT).toContain("small, feasible product experiment");
		expect(PRODUCT_ANALYST_PROMPT).toContain("tradeoff or condition");
		expect(PRODUCT_ANALYST_PROMPT).toContain("without inventing baselines");
		expect(PRODUCT_ANALYST_PROMPT).toContain("say what would resolve it");
		expect(PRODUCT_ANALYST_PROMPT).toContain("untrusted research material");
	});
});
