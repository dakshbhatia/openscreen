import { describe, expect, it } from "vitest";
import { DEFAULT_INTEL_SETTINGS, type IntelReport } from "./product-intel";
import {
	getReportCompanyContext,
	reportToExportData,
	reportToMarkdown,
} from "./product-intel-export";

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

const briefReport: IntelReport = {
	...report,
	analysis: {
		...report.analysis,
		understanding: {
			product: "A project workspace",
			audience: "Possibly small studios",
			job: "Organize shared projects",
			confidence: "low",
		},
		readout: {
			strengths: [
				{
					title: "A recognizable home",
					reason: "Naming may help studios identify shared projects.",
					basis: "inferred",
					confidence: "medium",
					evidenceTimesSec: [2.25, 64.125],
				},
			],
			frictions: [],
		},
		decisions: [
			{
				title: "Validate deferred naming",
				recommendation: "investigate",
				rationale: "Setup requests a name.",
				counterEvidence: "Naming may help orientation.",
				experiment: "Observe whether studios can find their project after skipping naming.",
				tradeoff: "Deferral may make shared work harder to identify.",
				confidence: "low",
				evidenceTimesSec: [2.25],
			},
		],
		pieces: [
			{
				name: "Onboarding",
				purpose: "A workspace name gives shared projects a recognizable home.",
				timeSec: 2.25,
			},
		],
	},
};

describe("product intelligence Markdown export", () => {
	it("exports the exact research goal and allowlisted journey with linked raw timestamps", () => {
		const input: IntelReport = {
			...briefReport,
			settings: {
				...briefReport.settings,
				researchGoal: "  Why does setup stop here?!\nKeep this exact.  ",
			},
			analysis: {
				...briefReport.analysis,
				journey: {
					goal: "Create a workspace",
					goalBasis: "inferred",
					coverage: "partial",
					outcome: "The form appears, but the recording does not show completion.",
					stages: [{ name: "Setup", purpose: "Name shared work.", evidenceTimesSec: [2.25, 10] }],
				},
			},
		};
		const before = JSON.stringify(input);
		const exported = reportToExportData(input);
		expect(exported.context.researchGoal).toBe(input.settings.researchGoal);
		expect(exported.analysis.journey).toEqual(input.analysis.journey);
		const markdown = reportToMarkdown(input);
		for (const part of [
			"### Research goal",
			"Why does setup stop here?!",
			"Keep this exact.",
			"## Goal-led journey",
			"Goal basis: inferred",
			"Coverage: partial",
			"Create a workspace",
			"does not show completion",
			"Name shared work.",
			"[00:02 (2.25s)](#raw-source-2.25s)",
			'<a id="raw-source-2.25s"></a>',
			"[00:10 (10s)](#raw-source-10s)",
			'<a id="raw-source-10s"></a>',
		])
			expect(markdown).toContain(part);
		expect(JSON.stringify(input)).toBe(before);
		expect(reportToExportData(report).analysis).not.toHaveProperty("journey");
		expect(reportToMarkdown(report)).not.toContain("## Goal-led journey");
	});
	it("redacts unmistakable secrets in journey prose without exporting unlisted metadata", () => {
		const key = `AIza${"a".repeat(35)}`;
		const journey = {
			goal: `Inspect ${key}`,
			goalBasis: "unknown" as const,
			coverage: "partial" as const,
			outcome: "No completion shown.",
			stages: [
				{
					name: "Setup",
					purpose: "/Users/private/source.mp4",
					evidenceTimesSec: [1],
					privateKey: "secret-nested",
				},
			],
			privateKey: "secret-journey",
		};
		const input = { ...report, analysis: { ...report.analysis, journey } };
		const json = JSON.stringify(reportToExportData(input));
		const markdown = reportToMarkdown(input);
		for (const value of [json, markdown]) {
			expect(value).not.toContain(key);
			expect(value).not.toContain("/Users/private");
			expect(value).not.toContain("secret-nested");
			expect(value).not.toContain("secret-journey");
			expect(value).toContain("[redacted]");
		}
	});
	it("exports the complete compact product brief and raw evidence times in JSON and Markdown", () => {
		const before = JSON.stringify(briefReport);
		const exported = reportToExportData(briefReport);
		for (const field of ["understanding", "readout", "decisions", "pieces"] as const)
			expect(exported.analysis[field]).toEqual(briefReport.analysis[field]);
		const markdown = reportToMarkdown(briefReport);
		for (const content of [
			"## Product understanding",
			"A project workspace",
			"Possibly small studios",
			"Organize shared projects",
			"## Strengths",
			"A recognizable home",
			"Naming may help studios identify shared projects.",
			"Basis: inferred",
			"Confidence: medium",
			"00:02 (2.25s), 01:04 (64.125s)",
			"## Frictions",
			"No supported insights reported.",
			"## Product decisions",
			"Validate deferred naming",
			"Recommendation: investigate",
			"Setup requests a name.",
			"Naming may help orientation.",
			"Observe whether studios can find their project after skipping naming.",
			"Deferral may make shared work harder to identify.",
			"## Product parts and purposes",
			"Onboarding",
			"A workspace name gives shared projects a recognizable home.",
		])
			expect(markdown).toContain(content);
		expect(JSON.stringify(briefReport)).toBe(before);
		expect(reportToExportData(report).analysis).not.toHaveProperty("pieces");
		expect(reportToMarkdown(report)).not.toContain("## Product understanding");
	});
	it("allowlists new product part metadata and redacts unmistakable secrets in new Markdown prose", () => {
		const key = `AIza${"a".repeat(35)}`;
		const input = {
			...briefReport,
			analysis: {
				...briefReport.analysis,
				pieces: [
					{
						name: "Onboarding",
						purpose: `Visible ${key} /Users/researcher/private.png`,
						timeSec: 2.25,
						apiKey: "private-nested-key",
						sourcePath: "/Users/researcher/source.mp4",
					},
				],
			},
		};
		const exported = reportToExportData(input);
		expect(exported.analysis.pieces?.[0]).toEqual({
			name: "Onboarding",
			purpose: "Visible [redacted] [redacted]",
			timeSec: 2.25,
		});
		expect(JSON.stringify(exported)).not.toContain("private-nested-key");
		expect(JSON.stringify(exported)).not.toContain("source.mp4");
		expect(JSON.stringify(exported)).not.toContain(key);
		expect(JSON.stringify(exported)).not.toContain("/Users/researcher");
		const markdown = reportToMarkdown(input);
		expect(markdown).toContain("Visible [redacted] [redacted]");
		expect(markdown).not.toContain(key);
	});

	it("uses retrieved company context when the optional written brief is absent", () => {
		const input: IntelReport = {
			...report,
			settings: { ...report.settings, productBrief: "", companyDomain: "https://example.com" },
			companyContext: {
				domain: "https://example.com",
				status: "retrieved",
				sourceUrls: ["https://example.com/"],
			},
		};
		expect(reportToMarkdown(input)).toContain(
			"Not supplied; company website supplies product context.",
		);
		expect(reportToMarkdown(input)).not.toContain("Not supplied; relevance is provisional.");
		expect(reportToMarkdown({ ...input, companyContext: undefined })).toContain(
			"Not supplied; relevance is provisional.",
		);
	});
	it("exports verified website retrieval and company domain in both formats", () => {
		const input: IntelReport = {
			...report,
			settings: { ...report.settings, companyDomain: "https://example.com" },
			companyContext: {
				domain: "https://example.com",
				status: "retrieved",
				sourceUrls: ["https://www.example.com/about"],
			},
		};
		const markdown = reportToMarkdown(input);
		expect(markdown).toContain("### Company domain\n\n> https://example.com");
		expect(markdown).toContain("Retrieved; confirmed by provider URL tool metadata.");
		expect(markdown).toContain("https://www.example.com/about");
		const exported = reportToExportData(input);
		expect(exported.context.companyDomain).toBe("https://example.com");
		expect(exported.companyContext).toEqual(input.companyContext);
		expect(exported.context.productBrief).toBe(input.settings.productBrief);
	});
	it("never upgrades a supplied domain or unrelated metadata into a retrieval claim", () => {
		const input: IntelReport = {
			...report,
			settings: { ...report.settings, companyDomain: "https://example.com" },
		};
		for (const value of [
			input,
			{
				...input,
				companyContext: {
					domain: "https://other.com",
					status: "retrieved" as const,
					sourceUrls: ["https://other.com/"],
				},
			},
			{ ...input, companyContext: { domain: "", status: "unavailable" as const, sourceUrls: [] } },
		]) {
			expect(getReportCompanyContext(value)).toEqual({
				domain: "https://example.com",
				status: "unavailable",
				sourceUrls: [],
			});
			expect(reportToExportData(value).companyContext?.status).toBe("unavailable");
			expect(reportToMarkdown(value)).toContain("website retrieval was not confirmed");
			expect(reportToMarkdown(value)).not.toContain("https://other.com");
		}
		expect(reportToExportData(report)).not.toHaveProperty("companyContext");
		expect(reportToMarkdown(report)).toContain("No company domain supplied");
	});
	it("allowlists JSON context and evidence fields without rewriting the supplied brief", () => {
		const privateReport = {
			...report,
			apiKey: "private-report-key",
			settings: {
				...report.settings,
				productBrief: "My quirky brief!\n  Keep these spaces.",
				apiKey: "private-settings-key",
				systemPrompt: "private custom instructions",
			},
			sourcePath: "/Users/researcher/recording.mp4",
			analysis: {
				...report.analysis,
				privateDebug: "private-analysis-debug",
				findings: report.analysis.findings.map((finding) => ({
					...finding,
					sourcePath: "/Users/researcher/private.mp4",
				})),
			},
		};
		const exported = reportToExportData(privateReport);
		expect(exported.context.productBrief).toBe(privateReport.settings.productBrief);
		const encoded = JSON.stringify(exported);
		for (const privateValue of [
			"private-report-key",
			"private-settings-key",
			"private custom instructions",
			"/Users/researcher",
			"private-analysis-debug",
		]) {
			expect(encoded).not.toContain(privateValue);
		}
	});
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
