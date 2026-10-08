import { describe, expect, it } from "vitest";
import { DEFAULT_INTEL_SETTINGS } from "./product-intel";
import {
	buildScreenshotPrompt,
	parseScreenshotAnalysis,
	SCREENSHOT_ANALYST_PROMPT,
	type ScreenshotAnalysis,
	type ScreenshotImage,
	screenshotAnalysisSchema,
	screenshotBatchIdSchema,
	screenshotBatchSchema,
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

describe("screenshot intelligence contract", () => {
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
	});
});
