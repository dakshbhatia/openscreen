import { describe, expect, it } from "vitest";
import { DEFAULT_INTEL_SETTINGS, type IntelReport } from "./product-intel";
import { reportToMarkdown } from "./product-intel-export";

const report: IntelReport = {
	projectId: "project-1",
	assetId: "asset-1",
	createdAt: "2026-10-08T14:15:00.000Z",
	sourceFingerprint: "abc123",
	durationSec: 95.5,
	remoteFileDeleted: true,
	settings: {
		...DEFAULT_INTEL_SETTINGS,
		productBrief: "A tool for solo architects.\nKeep the setup small.",
		competitor: "Example App",
		task: "Create a project",
	},
	analysis: {
		summary: "Setup precedes first value.",
		steps: [{ timeSec: 2.25, action: "Create workspace", evidence: "A form appears." }],
		findings: [
			{
				timeSec: 64.125,
				category: "activation",
				observation: "A sample board appears.",
				hypothesis: "Sample content may reduce setup effort.",
				implication: "Test a sample board and observe whether architects reach first value.",
				confidence: "medium",
			},
		],
		unknowns: ["Conversion impact cannot be determined."],
	},
};

describe("product intelligence Markdown export", () => {
	it("exports context, raw evidence, decisions and whitelisted report metadata", () => {
		const markdown = reportToMarkdown(report);
		for (const value of [
			"## Context",
			"> A tool for solo architects.\n> Keep the setup small.",
			"> Example App",
			"> Create a project",
			"Created at: 2026-10-08T14:15:00.000Z",
			`Model: ${report.settings.model}`,
			"Project ID: project-1",
			"Asset ID: asset-1",
			"Source fingerprint: abc123",
			"Raw source duration: 95.5s",
			"Remote file deletion confirmed: yes",
			"00:02 (2.25s)",
			"01:04 (64.125s)",
			"**Observation**",
			"> A sample board appears.",
			"**Hypothesis**",
			"> Sample content may reduce setup effort.",
			"**Implication / experiment**",
			"> Test a sample board and observe whether architects reach first value.",
			"Confidence: medium",
			"## Unknowns and limitations",
			"> Conversion impact cannot be determined.",
		])
			expect(markdown).toContain(value);
	});
	it("is deterministic, preserves finding order, and does not mutate the report", () => {
		const input: IntelReport = {
			...report,
			analysis: {
				...report.analysis,
				findings: [report.analysis.findings[0], { ...report.analysis.findings[0], timeSec: 1 }],
			},
		};
		const before = JSON.stringify(input);
		const markdown = reportToMarkdown(input);
		expect(markdown).toBe(reportToMarkdown(input));
		expect(markdown.indexOf("64.125s")).toBeLessThan(markdown.indexOf("00:01 (1s)"));
		expect(JSON.stringify(input)).toBe(before);
	});
	it("handles absent context, empty evidence and unconfirmed deletion explicitly", () => {
		const markdown = reportToMarkdown({
			...report,
			settings: DEFAULT_INTEL_SETTINGS,
			remoteFileDeleted: false,
			analysis: { summary: "No legible flow.", steps: [], findings: [], unknowns: [] },
		});
		expect(markdown).toContain("Not supplied; relevance is provisional.");
		expect(markdown).toContain("No timestamped journey steps reported.");
		expect(markdown).toContain("No timestamped findings reported.");
		expect(markdown).toContain("No unknowns reported; this does not establish their absence.");
		expect(markdown).toContain("Remote file deletion confirmed: no");
	});
	it("omits private fields and system instructions instead of serializing the report", () => {
		const privateReport = {
			...report,
			settings: {
				...report.settings,
				systemPrompt: "private custom instructions",
				apiKey: "private-key",
			},
			sourcePath: "/Users/researcher/recording.mp4",
		};
		const markdown = reportToMarkdown(privateReport);
		expect(markdown).not.toContain("private-key");
		expect(markdown).not.toContain("private custom instructions");
		expect(markdown).not.toContain("/Users/researcher");
	});
	it("visibly redacts unmistakable local paths and Gemini keys in evidence text", () => {
		const key = `AIza${"a".repeat(35)}`;
		const markdown = reportToMarkdown({
			...report,
			analysis: {
				...report.analysis,
				unknowns: [
					`Visible key ${key}`,
					"/Users/researcher/secret.mp4",
					"C:\\Users\\researcher\\secret.mp4",
					"file:///tmp/secret.mp4",
					"Investigate https://example.com/home/project and pricing / team fit.",
				],
			},
		});
		expect(markdown).not.toContain(key);
		expect(markdown).not.toContain("secret.mp4");
		expect(markdown).toContain("Visible key [redacted]");
		expect(markdown).toContain("https://example.com/home/project");
		expect(markdown).toContain("pricing / team fit");
	});
});
