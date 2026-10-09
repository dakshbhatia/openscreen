import { describe, expect, it } from "vitest";
import { DEFAULT_INTEL_SETTINGS } from "./product-intel";
import {
	buildScreenshotPrompt,
	MAX_SCREENSHOT_BATCH_BYTES,
	MAX_SCREENSHOT_EVIDENCE_IMAGES,
	MAX_SCREENSHOT_IMAGES,
	MAX_SCREENSHOT_REQUEST_IMAGES,
	parseScreenshotAnalysis,
	SCREENSHOT_ANALYST_PROMPT,
	SCREENSHOT_SYNTHESIS_PROMPT,
	type ScreenshotAnalysis,
	type ScreenshotDecision,
	type ScreenshotImage,
	type ScreenshotReadoutInsight,
	screenshotAnalysisSchema,
	screenshotBatchIdSchema,
	screenshotBatchSchema,
	screenshotDecisionSchema,
	screenshotImageSchema,
	screenshotReadoutInsightSchema,
	screenshotReadoutSchema,
	screenshotUnderstandingSchema,
} from "./screenshot-intel";

const images: ScreenshotImage[] = [
	{
		id: "image_00000000-0000-0000-0000-000000000001",
		originalName: "start.png",
		path: "/managed/start.png",
		mimeType: "image/png",
		width: 100,
		height: 200,
	},
	{
		id: "image_00000000-0000-0000-0000-000000000002",
		originalName: "workspace.png",
		path: "/managed/workspace.png",
		mimeType: "image/png",
		width: 100,
		height: 200,
	},
];
const analysis: ScreenshotAnalysis = {
	summary: "Setup asks for workspace details.",
	screens: images.map((image) => ({
		imageId: image.id,
		label: "Workspace form",
		group: "Setup",
		observation: "The form requests a workspace name.",
		hypothesis: "This may help identify a shared space.",
		advice:
			"For solo architects, test postponing the team name; verify whether users can start their first project without losing orientation.",
		confidence: "medium",
	})),
	unknowns: ["Screenshots do not establish the order of these screens."],
};

const decision: ScreenshotDecision = {
	title: "Defer team setup for solo work",
	recommendation: "adapt",
	rationale: "Visible setup requests a team name before work.",
	counterEvidence: "Shared work may require immediate naming.",
	experiment: "Observe whether solo users begin their project and recognize it later.",
	tradeoff: "Less setup can reduce early orientation.",
	confidence: "medium",
	evidenceImageIds: images.map((image) => image.id),
};

const insight: ScreenshotReadoutInsight = {
	title: "A named place for shared work",
	reason:
		"The workspace name gives teammates a recognizable place to return to when resuming shared work.",
	basis: "inferred",
	confidence: "medium",
	evidenceImageIds: [images[0].id],
};

describe("screenshot intelligence contract", () => {
	it("accepts a single 120-screen collection while retaining 24-image request and citation caps", () => {
		expect(MAX_SCREENSHOT_IMAGES).toBe(120);
		expect(MAX_SCREENSHOT_REQUEST_IMAGES).toBe(24);
		expect(MAX_SCREENSHOT_EVIDENCE_IMAGES).toBe(24);
		expect(MAX_SCREENSHOT_BATCH_BYTES).toBe(192 * 1024 * 1024);
		const bulkImages = Array.from({ length: 120 }, (_, index) => ({
			...images[0],
			id: `image_00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
		}));
		const bulkAnalysis = {
			...analysis,
			screens: bulkImages.map((image) => ({ ...analysis.screens[0], imageId: image.id })),
		};
		expect(parseScreenshotAnalysis(bulkAnalysis, bulkImages).screens).toHaveLength(120);
		const batch = {
			id: "batch_00000000-0000-0000-0000-000000000001",
			title: "Bulk",
			createdAt: new Date().toISOString(),
			images: bulkImages,
			analysis: bulkAnalysis,
		};
		expect(screenshotBatchSchema.parse(batch).images).toHaveLength(120);
		expect(
			screenshotBatchSchema.safeParse({ ...batch, images: [...bulkImages, images[1]] }).success,
		).toBe(false);
	});
	it("grounds synthesis in every unordered chunk and preserves uncertainty between distinct products", () => {
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("multiple products");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("Disambiguate group names");
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain("every screenshot's evidence");
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain("1 to 24 unique evidenceImageIds");
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain("Do not repeat a screens array");
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain("never chronological steps");
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain(
			"screenGroups assigns canonical group names across the whole collection",
		);
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain("Merge equivalent labels");
		expect(SCREENSHOT_SYNTHESIS_PROMPT).toContain("Do not split groups by processing chunk");
		for (const prompt of [SCREENSHOT_ANALYST_PROMPT, SCREENSHOT_SYNTHESIS_PROMPT]) {
			expect(prompt).toContain("basis applies to its entire reason");
			expect(prompt).toContain(
				"A visible button does not prove a working action or absence of dead ends",
			);
		}
	});

	it("keeps thumbnail paths optional for legacy images and bounds new metadata", () => {
		expect(screenshotImageSchema.parse(images[0])).not.toHaveProperty("thumbnailPath");
		expect(
			screenshotImageSchema.parse({ ...images[0], thumbnailPath: "/managed/thumbnail.webp" })
				.thumbnailPath,
		).toBe("/managed/thumbnail.webp");
		for (const thumbnailPath of ["", "x".repeat(4097)])
			expect(screenshotImageSchema.safeParse({ ...images[0], thumbnailPath }).success).toBe(false);
	});

	it("requires exactly one evidence entry per supplied screenshot and preserves returned order", () => {
		const raw = { ...analysis, screens: [...analysis.screens].reverse() };
		expect(parseScreenshotAnalysis(raw, images).screens.map((screen) => screen.imageId)).toEqual(
			images.map((image) => image.id).reverse(),
		);
	});
	it.each([
		{ ...analysis, screens: [analysis.screens[0]] },
		{ ...analysis, screens: [analysis.screens[0], analysis.screens[0]] },
		{
			...analysis,
			screens: [
				analysis.screens[0],
				{ ...analysis.screens[1], imageId: "image_00000000-0000-0000-0000-000000000099" },
			],
		},
	])("rejects missing, repeated or phantom image references", (raw) => {
		expect(() => parseScreenshotAnalysis(raw, images)).toThrow(/exactly once/i);
	});
	it("rejects extra model fields, missing evidence and unbounded labels", () => {
		expect(() => screenshotAnalysisSchema.parse({ ...analysis, flowOrder: [1, 2] })).toThrow();
		expect(() =>
			screenshotAnalysisSchema.parse({
				...analysis,
				screens: [{ ...analysis.screens[0], hypothesis: "" }],
			}),
		).toThrow();
		expect(() =>
			screenshotAnalysisSchema.parse({
				...analysis,
				screens: [{ ...analysis.screens[0], label: "x".repeat(121) }],
			}),
		).toThrow();
	});
	it("validates saved batches against their image coverage and disallows duplicate image IDs", () => {
		const batch = {
			id: "batch_00000000-0000-0000-0000-000000000001",
			title: "Screens",
			createdAt: "2026-10-08T14:15:00.000Z",
			images,
			analysis,
		};
		expect(screenshotBatchSchema.parse(batch).analysis?.screens).toHaveLength(2);
		expect(() =>
			screenshotBatchSchema.parse({ ...batch, images: [images[0], images[0]] }),
		).toThrow();
		expect(() =>
			screenshotBatchSchema.parse({
				...batch,
				analysis: { ...analysis, screens: [analysis.screens[0]] },
			}),
		).toThrow();
		expect(() => screenshotBatchSchema.parse({ ...batch, apiKey: "private" })).toThrow();
	});
	it("keeps duplicate counts optional for old reports and validates new counts", () => {
		const batch = {
			id: "batch_00000000-0000-0000-0000-000000000001",
			title: "Screens",
			createdAt: "2026-10-08T14:15:00.000Z",
			images,
			analysis,
		};
		expect(screenshotBatchSchema.parse(batch)).not.toHaveProperty("duplicatesSkipped");
		expect(screenshotBatchSchema.parse({ ...batch, duplicatesSkipped: 0 }).duplicatesSkipped).toBe(
			0,
		);
		expect(screenshotBatchSchema.parse({ ...batch, duplicatesSkipped: 2 }).duplicatesSkipped).toBe(
			2,
		);
		for (const count of [-1, 0.5, Infinity, "2"]) {
			expect(screenshotBatchSchema.safeParse({ ...batch, duplicatesSkipped: count }).success).toBe(
				false,
			);
		}
	});

	it("keeps older analyses unchanged and preserves ranked collection decisions", () => {
		expect(parseScreenshotAnalysis(analysis, images)).not.toHaveProperty("decisions");
		expect(parseScreenshotAnalysis(analysis, images)).not.toHaveProperty("understanding");
		expect(parseScreenshotAnalysis(analysis, images)).not.toHaveProperty("readout");
		expect(parseScreenshotAnalysis(analysis, images).screens[0]).not.toHaveProperty("purpose");
		const second = {
			...decision,
			title: "Investigate naming needs",
			recommendation: "investigate" as const,
		};
		expect(
			parseScreenshotAnalysis({ ...analysis, decisions: [decision, second] }, images).decisions,
		).toEqual([decision, second]);
		expect(parseScreenshotAnalysis({ ...analysis, decisions: [] }, images).decisions).toEqual([]);
	});
	it("accepts concise screen purposes and empty readout arrays without inventing insights", () => {
		const purpose =
			"This form lets a user name the workspace so shared work has a recognizable home.";
		const current = {
			...analysis,
			screens: analysis.screens.map((screen) => ({ ...screen, purpose })),
			readout: { strengths: [], frictions: [] },
		};
		expect(parseScreenshotAnalysis(current, images).screens[0].purpose).toBe(purpose);
		expect(parseScreenshotAnalysis(current, images).readout).toEqual({
			strengths: [],
			frictions: [],
		});
		for (const value of ["", "x".repeat(601)]) {
			expect(
				screenshotAnalysisSchema.safeParse({
					...current,
					screens: [{ ...current.screens[0], purpose: value }],
				}).success,
			).toBe(false);
		}
	});
	it("validates readout citations in both model parsing and persisted batches", () => {
		const batch = {
			id: "batch_00000000-0000-0000-0000-000000000001",
			title: "Screens",
			createdAt: "2026-10-08T14:15:00.000Z",
			images,
		};
		const readout = { strengths: [insight], frictions: [] };
		expect(parseScreenshotAnalysis({ ...analysis, readout }, images).readout).toEqual(readout);
		expect(
			screenshotBatchSchema.parse({ ...batch, analysis: { ...analysis, readout } }).analysis
				?.readout,
		).toEqual(readout);
		for (const evidenceImageIds of [
			[],
			[images[0].id, images[0].id],
			["image_00000000-0000-0000-0000-000000000099"],
		]) {
			const invalid = { strengths: [{ ...insight, evidenceImageIds }], frictions: [] };
			expect(() => parseScreenshotAnalysis({ ...analysis, readout: invalid }, images)).toThrow();
			expect(
				screenshotBatchSchema.safeParse({ ...batch, analysis: { ...analysis, readout: invalid } })
					.success,
			).toBe(false);
		}
	});
	it("caps readout text, insight counts and unique evidence references locally", () => {
		for (const field of ["strengths", "frictions"] as const) {
			expect(
				screenshotReadoutSchema.safeParse({
					strengths: [],
					frictions: [],
					[field]: Array.from({ length: 4 }, () => insight),
				}).success,
			).toBe(false);
		}
		for (const value of [
			{ ...insight, title: "x".repeat(141) },
			{ ...insight, reason: "x".repeat(901) },
			{ ...insight, basis: "proven" },
			{ ...insight, confidence: "certain" },
			{
				...insight,
				evidenceImageIds: Array.from(
					{ length: 25 },
					(_, index) => `image_00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
				),
			},
		])
			expect(screenshotReadoutInsightSchema.safeParse(value).success).toBe(false);
	});
	it("validates decision limits and evidence IDs in both API parsing and persisted reports", () => {
		const batch = {
			id: "batch_00000000-0000-0000-0000-000000000001",
			title: "Screens",
			createdAt: "2026-10-08T14:15:00.000Z",
			images,
		};
		for (const decisions of [
			Array.from({ length: 6 }, () => decision),
			[{ ...decision, evidenceImageIds: [] }],
			[{ ...decision, evidenceImageIds: [images[0].id, images[0].id] }],
			[{ ...decision, evidenceImageIds: ["image_00000000-0000-0000-0000-000000000099"] }],
			[
				{
					...decision,
					evidenceImageIds: Array.from(
						{ length: 25 },
						(_, index) => `image_00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
					),
				},
			],
		]) {
			expect(() => parseScreenshotAnalysis({ ...analysis, decisions }, images)).toThrow();
			expect(
				screenshotBatchSchema.safeParse({ ...batch, analysis: { ...analysis, decisions } }).success,
			).toBe(false);
		}
		expect(
			screenshotBatchSchema.parse({ ...batch, analysis: { ...analysis, decisions: [decision] } })
				.analysis?.decisions,
		).toEqual([decision]);
	});
	it("bounds all decision text and rejects unsupported recommendation/confidence values", () => {
		for (const [field, length] of [
			["title", 141],
			["rationale", 1501],
			["counterEvidence", 1001],
			["experiment", 1501],
			["tradeoff", 1001],
		] as const) {
			expect(
				screenshotDecisionSchema.safeParse({ ...decision, [field]: "x".repeat(length) }).success,
			).toBe(false);
		}
		expect(
			screenshotDecisionSchema.safeParse({ ...decision, recommendation: "copy" }).success,
		).toBe(false);
		expect(screenshotDecisionSchema.safeParse({ ...decision, confidence: "certain" }).success).toBe(
			false,
		);
	});
	it("bounds self-learned understanding while allowing unknown audience wording", () => {
		const understanding = {
			product: "A workspace product",
			audience: "Unknown from these screens",
			job: "Start a project",
			confidence: "low",
		};
		expect(screenshotUnderstandingSchema.parse(understanding)).toEqual(understanding);
		for (const [field, length] of [
			["product", 401],
			["audience", 401],
			["job", 601],
		] as const) {
			expect(
				screenshotUnderstandingSchema.safeParse({ ...understanding, [field]: "x".repeat(length) })
					.success,
			).toBe(false);
		}
	});

	it("rejects traversal and unrelated IDs", () => {
		for (const id of ["../settings", "/tmp/batch", "batch_../../secrets", "settings", "batch_1"]) {
			expect(screenshotBatchIdSchema.safeParse(id).success).toBe(false);
		}
	});
	it("sends the product brief and screenshot identities without local paths", () => {
		const prompt = buildScreenshotPrompt(
			{
				...DEFAULT_INTEL_SETTINGS,
				productBrief: "Solo architects\nMinimal setup",
				competitor: "Example",
				task: "Create a project",
			},
			images,
		);
		expect(prompt).toContain("Solo architects\\nMinimal setup");
		expect(prompt).toContain("Example");
		expect(prompt).toContain("Create a project");
		expect(prompt).toContain(images[0].id);
		expect(prompt).toContain("start.png");
		expect(prompt).not.toContain("/managed");
	});
	it("overrides recording assumptions with unordered, contextual evidence rules", () => {
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("Never infer chronology");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("every supplied imageId");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("small feasible product experiment");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("tradeoff");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("without inventing metrics");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("untrusted research data");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain(
			"product and job each need only one plain sentence",
		);
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("purpose in one sentence");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain(
			"Onboarding, Overview, Core work, Detail, Collaboration, Billing or Settings",
		);
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("Do not force these categories");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("Use plain words without PM jargon");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("prefer one or two strongly supported insights");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("one-sentence reason");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("Empty arrays are appropriate");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("Treat friction risks as hypotheses");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("never invent user failure");
		expect(SCREENSHOT_ANALYST_PROMPT).toContain("beautiful, good or bad are not reasons");
	});
});
