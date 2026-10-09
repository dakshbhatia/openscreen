import { describe, expect, it } from "vitest";
import {
	buildProductPrompt,
	DEFAULT_INTEL_SETTINGS,
	intelReportSchema,
	intelSettingsSchema,
	PRODUCT_ANALYST_PROMPT,
	PRODUCT_RECORDING_BRIEF_RULES,
	parseProductAnalysis,
	productAnalysisSchema,
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

const brief = {
	understanding: {
		product: "A workspace",
		audience: "Unknown",
		job: "Organize projects",
		confidence: "low",
	},
	readout: {
		strengths: [
			{
				title: "A recognizable home",
				reason: "Naming may help users find their workspace.",
				basis: "inferred",
				confidence: "medium",
				evidenceTimesSec: [0, 10],
			},
		],
		frictions: [],
	},
	decisions: [
		{
			title: "Validate naming",
			recommendation: "investigate",
			rationale: "Naming is visible.",
			counterEvidence: "Users may already recognize the workspace.",
			experiment: "Observe whether users can find their project.",
			tradeoff: "Extra naming can delay work.",
			confidence: "low",
			evidenceTimesSec: [0, 10],
		},
	],
	pieces: [
		{ name: "Onboarding", purpose: "A name gives shared work a recognizable home.", timeSec: 10 },
	],
};

describe("product intelligence evidence", () => {
	it("keeps legacy fields absent and accepts compact evidence at both duration endpoints", () => {
		for (const field of ["understanding", "readout", "decisions", "pieces", "journey"])
			expect(parseProductAnalysis(valid, 10)).not.toHaveProperty(field);
		expect(parseProductAnalysis({ ...valid, ...brief }, 10).pieces?.[0].timeSec).toBe(10);
		expect(
			parseProductAnalysis(
				{
					...valid,
					...brief,
					readout: { strengths: [], frictions: [] },
					decisions: [],
					pieces: [],
				},
				10,
			).decisions,
		).toEqual([]);
	});
	it("validates new evidence times in model responses and saved reports", () => {
		const report = {
			projectId: "proj_1",
			assetId: "asset_1",
			createdAt: "2026-10-08",
			sourceFingerprint: "old",
			durationSec: 9,
			settings: {},
			analysis: { ...valid, ...brief },
			remoteFileDeleted: true,
		};
		expect(() => intelReportSchema.parse(report)).toThrow(/duration/);
		for (const timeSec of [-1, 11, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() =>
				parseProductAnalysis({ ...valid, ...brief, pieces: [{ ...brief.pieces[0], timeSec }] }, 10),
			).toThrow();
		for (const evidenceTimesSec of [
			[],
			[1, 1],
			[-1],
			[11],
			[Number.NaN],
			Array.from({ length: 13 }, (_, index) => index),
		]) {
			expect(() =>
				parseProductAnalysis(
					{
						...valid,
						...brief,
						readout: {
							strengths: [{ ...brief.readout.strengths[0], evidenceTimesSec }],
							frictions: [],
						},
					},
					10,
				),
			).toThrow();
			expect(() =>
				parseProductAnalysis(
					{ ...valid, ...brief, decisions: [{ ...brief.decisions[0], evidenceTimesSec }] },
					10,
				),
			).toThrow();
		}
	});
	it("bounds product brief counts and text locally", () => {
		for (const raw of [
			{ ...brief, pieces: Array.from({ length: 13 }, () => brief.pieces[0]) },
			{ ...brief, decisions: Array.from({ length: 4 }, () => brief.decisions[0]) },
			{
				...brief,
				readout: {
					strengths: Array.from({ length: 4 }, () => brief.readout.strengths[0]),
					frictions: [],
				},
			},
			{
				...brief,
				readout: {
					strengths: [],
					frictions: Array.from({ length: 4 }, () => brief.readout.strengths[0]),
				},
			},
			{ ...brief, pieces: [{ ...brief.pieces[0], purpose: "x".repeat(601) }] },
			{ ...brief, understanding: { ...brief.understanding, job: "x".repeat(601) } },
			{
				...brief,
				readout: {
					strengths: [{ ...brief.readout.strengths[0], reason: "x".repeat(901) }],
					frictions: [],
				},
			},
		])
			expect(productAnalysisSchema.safeParse({ ...valid, ...raw }).success).toBe(false);
	});
	it("asks for plain product purpose, conditional causal claims and supported next decisions", () => {
		for (const instruction of [
			"never infer our company",
			"without PM jargon",
			"basis applies to the entire reason",
			"conditional",
			"A visible button does not prove a working action",
			"at most three ranked next product decisions",
			"Do not invent baselines",
			"one to twelve unique evidenceTimesSec",
			"Return all four brief fields",
		])
			expect(PRODUCT_RECORDING_BRIEF_RULES).toContain(instruction);
	});

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

describe("goal-led recording journeys", () => {
	const journey = {
		goal: "Create a shared workspace",
		goalBasis: "inferred",
		coverage: "partial",
		outcome: "The workspace form is visible; successful creation is not shown.",
		stages: [
			{
				name: "Name workspace",
				purpose: "Give shared work a recognizable home.",
				evidenceTimesSec: [2],
			},
		],
	};
	it("preserves exact optional research questions separately from the attempted task", () => {
		const researchGoal = "  Does naming help solo folks?\nKeep MY words!!  ";
		const settings = intelSettingsSchema.parse({ researchGoal, task: "Create workspace" });
		expect(settings.researchGoal).toBe(researchGoal);
		expect(intelSettingsSchema.parse({}).researchGoal).toBe("");
		expect(buildProductPrompt(settings)).toContain(JSON.stringify(researchGoal));
		expect(buildProductPrompt(settings)).toContain('"task":"Create workspace"');
		expect(() => intelSettingsSchema.parse({ researchGoal: "x".repeat(2001) })).toThrow();
	});
	it("accepts partial journeys and an explicitly unknown goal with no fabricated stages", () => {
		expect(parseProductAnalysis({ ...valid, journey }, 10).journey).toEqual(journey);
		expect(
			parseProductAnalysis(
				{ ...valid, journey: { ...journey, goalBasis: "unknown", stages: [] } },
				10,
			).journey?.stages,
		).toEqual([]);
	});
	it("rejects unordered recording stages and invalid or unsupported evidence", () => {
		const stage = journey.stages[0];
		for (const candidate of [
			{ ...journey, coverage: "collection" },
			{ ...journey, goal: "" },
			{ ...journey, stages: [{ ...stage, evidenceTimesSec: [] }] },
			{ ...journey, stages: [{ ...stage, evidenceTimesSec: [2, 2] }] },
			{ ...journey, stages: [{ ...stage, evidenceTimesSec: [11] }] },
			{ ...journey, stages: [{ ...stage, evidenceTimesSec: [-1] }] },
			{ ...journey, stages: [{ ...stage, evidenceTimesSec: [8] }, stage] },
			{ ...journey, stages: Array.from({ length: 9 }, () => stage) },
		])
			expect(() => parseProductAnalysis({ ...valid, journey: candidate }, 10)).toThrow();
		const report = {
			projectId: "p",
			assetId: "a",
			createdAt: "today",
			sourceFingerprint: "f",
			durationSec: 1,
			settings: {},
			analysis: { ...valid, journey },
			remoteFileDeleted: true,
		};
		expect(() => intelReportSchema.parse(report)).toThrow(/duration/);
	});
});
