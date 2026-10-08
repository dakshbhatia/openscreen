import { type CompanyContext, companyContextSchema, companyDomainSchema } from "./company-context";
import type { IntelReport } from "./product-intel";

/** Keep unverified, missing or unrelated website metadata from becoming a retrieval claim. */
export function getReportCompanyContext(report: IntelReport): CompanyContext | undefined {
	const domain = companyDomainSchema.safeParse(report.settings.companyDomain ?? "");
	if (!domain.success || !domain.data) return undefined;
	const unavailable: CompanyContext = {
		domain: domain.data,
		status: "unavailable",
		sourceUrls: [],
	};
	const context = companyContextSchema.safeParse(report.companyContext);
	if (!context.success || !context.data.domain) return unavailable;
	const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");
	if (host(context.data.domain) !== host(domain.data)) return unavailable;
	return {
		domain: domain.data,
		status: context.data.status,
		sourceUrls: [...context.data.sourceUrls],
	};
}

/** A shareable field allowlist, with the supplied product brief preserved verbatim. */
export function reportToExportData(report: IntelReport) {
	const companyContext = getReportCompanyContext(report);
	return {
		projectId: report.projectId,
		assetId: report.assetId,
		createdAt: report.createdAt,
		durationSec: report.durationSec,
		sourceFingerprint: report.sourceFingerprint,
		remoteFileDeleted: report.remoteFileDeleted,
		context: {
			companyDomain: companyContext?.domain ?? "",
			productBrief: report.settings.productBrief,
			competitor: report.settings.competitor,
			task: report.settings.task,
			model: report.settings.model,
		},
		...(companyContext ? { companyContext } : {}),
		analysis: {
			summary: report.analysis.summary,
			steps: report.analysis.steps.map(({ timeSec, action, evidence }) => ({
				timeSec,
				action,
				evidence,
			})),
			findings: report.analysis.findings.map(
				({ timeSec, category, observation, hypothesis, implication, confidence }) => ({
					timeSec,
					category,
					observation,
					hypothesis,
					implication,
					confidence,
				}),
			),
			unknowns: [...report.analysis.unknowns],
		},
	};
}

// Export an explicit allowlist rather than serializing settings or the report.
// Redactions are visible, and only cover unmistakable secrets/local paths.
function text(value: string): string {
	return value
		.replace(/AIza[\w-]{35}/g, "[redacted]")
		.replace(/file:\/\/[^\s<>"`]+/gi, "[redacted]")
		.replace(/(?:[A-Za-z]:\\|\\\\)[^\s<>"`]+/g, "[redacted]")
		.replace(/(?<![\w:/])\/(?:Users|home|private|Volumes)\/[^\s<>"`]+/g, "[redacted]");
}

function quote(value: string): string {
	return text(value)
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
		.join("\n");
}

function timestamp(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.floor(seconds % 60);
	return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")} (${seconds}s)`;
}

/** A comparison-ready report whose timestamps always refer to the raw source. */
export function reportToMarkdown(report: IntelReport): string {
	const { analysis, settings } = report;
	const companyContext = getReportCompanyContext(report);
	const sections = [
		"# Product intelligence report",
		"## Context",
		`### Company domain\n\n${quote(companyContext?.domain || "Not supplied")}`,
		`### Company website retrieval\n\n${
			companyContext?.status === "retrieved"
				? `Retrieved; confirmed by provider URL tool metadata.\n\n${companyContext.sourceUrls.map((url) => `- ${text(url)}`).join("\n")}`
				: companyContext
					? "Unavailable; company website retrieval was not confirmed. Company fit remains provisional."
					: "No company domain supplied; company website retrieval was not requested."
		}`,
		`### Product brief\n\n${quote(settings.productBrief || (companyContext?.status === "retrieved" ? "Not supplied; company website supplies product context." : "Not supplied; relevance is provisional."))}`,
		`### Competitor\n\n${quote(settings.competitor || "Not labelled")}`,
		`### Task\n\n${quote(settings.task || "Not supplied; any inferred task needs validation.")}`,
		"## Report metadata",
		`- Created at: ${text(report.createdAt)}\n- Model: ${text(settings.model)}\n- Project ID: ${text(report.projectId)}\n- Asset ID: ${text(report.assetId)}\n- Source fingerprint: ${text(report.sourceFingerprint)}\n- Raw source duration: ${report.durationSec}s\n- Remote file deletion confirmed: ${report.remoteFileDeleted ? "yes" : "no"}`,
		"All evidence timestamps are seconds from the beginning of the raw recording, independent of editor cuts or zooms. Findings retain their reported order; confidence does not establish business impact.",
		`## Summary\n\n${quote(analysis.summary)}`,
		"## Journey",
	];
	if (!analysis.steps.length) sections.push("No timestamped journey steps reported.");
	for (const [index, step] of analysis.steps.entries()) {
		sections.push(
			`### Step ${index + 1} — ${timestamp(step.timeSec)}\n\n**Action**\n\n${quote(step.action)}\n\n**Visible evidence**\n\n${quote(step.evidence)}`,
		);
	}
	sections.push("## Findings");
	if (!analysis.findings.length) sections.push("No timestamped findings reported.");
	for (const [index, finding] of analysis.findings.entries()) {
		sections.push(
			`### Finding ${index + 1} — ${finding.category}\n\n- Raw source timestamp: ${timestamp(finding.timeSec)}\n- Confidence: ${finding.confidence}\n\n**Observation**\n\n${quote(finding.observation)}\n\n**Hypothesis**\n\n${quote(finding.hypothesis)}\n\n**Implication / experiment**\n\n${quote(finding.implication)}`,
		);
	}
	sections.push("## Unknowns and limitations");
	if (!analysis.unknowns.length)
		sections.push("No unknowns reported; this does not establish their absence.");
	for (const [index, unknown] of analysis.unknowns.entries()) {
		sections.push(`### Unknown ${index + 1}\n\n${quote(unknown)}`);
	}
	return `${sections.join("\n\n")}\n`;
}
