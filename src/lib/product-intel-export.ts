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
			researchGoal: report.settings.researchGoal ?? "",
			companyDomain: companyContext?.domain ?? "",
			productBrief: report.settings.productBrief,
			competitor: report.settings.competitor,
			task: report.settings.task,
			model: report.settings.model,
		},
		...(companyContext ? { companyContext } : {}),
		analysis: {
			summary: report.analysis.summary,
			...(report.analysis.journey
				? {
						journey: {
							goal: text(report.analysis.journey.goal),
							goalBasis: report.analysis.journey.goalBasis,
							outcome: text(report.analysis.journey.outcome),
							coverage: report.analysis.journey.coverage,
							stages: report.analysis.journey.stages.map(({ name, purpose, evidenceTimesSec }) => ({
								name: text(name),
								purpose: text(purpose),
								evidenceTimesSec: [...evidenceTimesSec],
							})),
						},
					}
				: {}),
			...(report.analysis.understanding
				? {
						understanding: {
							product: text(report.analysis.understanding.product),
							audience: text(report.analysis.understanding.audience),
							job: text(report.analysis.understanding.job),
							confidence: report.analysis.understanding.confidence,
						},
					}
				: {}),
			...(report.analysis.readout
				? {
						readout: {
							strengths: report.analysis.readout.strengths.map(
								({ title, reason, basis, confidence, evidenceTimesSec }) => ({
									title: text(title),
									reason: text(reason),
									basis,
									confidence,
									evidenceTimesSec: [...evidenceTimesSec],
								}),
							),
							frictions: report.analysis.readout.frictions.map(
								({ title, reason, basis, confidence, evidenceTimesSec }) => ({
									title: text(title),
									reason: text(reason),
									basis,
									confidence,
									evidenceTimesSec: [...evidenceTimesSec],
								}),
							),
						},
					}
				: {}),
			...(report.analysis.decisions
				? {
						decisions: report.analysis.decisions.map(
							({
								title,
								recommendation,
								rationale,
								counterEvidence,
								experiment,
								tradeoff,
								confidence,
								evidenceTimesSec,
							}) => ({
								title: text(title),
								recommendation,
								rationale: text(rationale),
								counterEvidence: text(counterEvidence),
								experiment: text(experiment),
								tradeoff: text(tradeoff),
								confidence,
								evidenceTimesSec: [...evidenceTimesSec],
							}),
						),
					}
				: {}),
			...(report.analysis.pieces
				? {
						pieces: report.analysis.pieces.map(({ name, purpose, timeSec }) => ({
							name: text(name),
							purpose: text(purpose),
							timeSec,
						})),
					}
				: {}),
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
		`### Research goal\n\n${quote(settings.researchGoal || "Not supplied; any inferred goal needs validation.")}`,
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
	];
	if (analysis.journey) {
		const journey = analysis.journey;
		sections.push(
			`## Goal-led journey\n\n**Goal**\n\n${quote(journey.goal)}\n\n- Goal basis: ${journey.goalBasis}\n- Coverage: ${journey.coverage}\n\n**Observed outcome and gaps**\n\n${quote(journey.outcome)}`,
		);
		if (!journey.stages.length) sections.push("No supported journey stages reported.");
		for (const stage of journey.stages)
			sections.push(
				`### ${text(stage.name)}\n\n${quote(stage.purpose)}\n\n- Raw source evidence: ${stage.evidenceTimesSec.map((seconds) => `[${timestamp(seconds)}](#raw-source-${seconds}s)`).join(", ")}`,
			);
	}
	if (analysis.understanding) {
		const understanding = analysis.understanding;
		sections.push(
			`## Product understanding\n\n**Product**\n\n${quote(understanding.product)}\n\n**Audience**\n\n${quote(understanding.audience)}\n\n**Job**\n\n${quote(understanding.job)}\n\n- Confidence: ${understanding.confidence}`,
		);
	}
	if (analysis.readout) {
		for (const [name, insights] of [
			["Strengths", analysis.readout.strengths],
			["Frictions", analysis.readout.frictions],
		] as const) {
			sections.push(`## ${name}`);
			if (!insights.length) sections.push("No supported insights reported.");
			for (const insight of insights)
				sections.push(
					`### ${text(insight.title)}\n\n${quote(insight.reason)}\n\n- Basis: ${insight.basis}\n- Confidence: ${insight.confidence}\n- Raw source evidence: ${insight.evidenceTimesSec.map(timestamp).join(", ")}`,
				);
		}
	}
	if (analysis.decisions) {
		sections.push("## Product decisions");
		if (!analysis.decisions.length) sections.push("No supported product decisions reported.");
		for (const decision of analysis.decisions)
			sections.push(
				`### ${text(decision.title)}\n\n- Recommendation: ${decision.recommendation}\n- Confidence: ${decision.confidence}\n- Raw source evidence: ${decision.evidenceTimesSec.map(timestamp).join(", ")}\n\n**Rationale**\n\n${quote(decision.rationale)}\n\n**Counterevidence**\n\n${quote(decision.counterEvidence)}\n\n**Experiment**\n\n${quote(decision.experiment)}\n\n**Tradeoff**\n\n${quote(decision.tradeoff)}`,
			);
	}
	if (analysis.pieces) {
		sections.push("## Product parts and purposes");
		if (!analysis.pieces.length) sections.push("No supported product parts reported.");
		for (const piece of analysis.pieces)
			sections.push(
				`### ${text(piece.name)} — ${timestamp(piece.timeSec)}\n\n${quote(piece.purpose)}`,
			);
	}
	sections.push(analysis.journey ? "## Timestamped actions" : "## Journey");
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
	if (analysis.journey?.stages.length) {
		sections.push("## Raw source timestamp index");
		const times = [...new Set(analysis.journey.stages.flatMap((stage) => stage.evidenceTimesSec))];
		for (const seconds of times.sort((a, b) => a - b)) {
			const evidence = analysis.steps
				.filter((step) => step.timeSec === seconds)
				.map((step) => step.evidence);
			sections.push(
				`<a id="raw-source-${seconds}s"></a>\n\n### ${timestamp(seconds)}${evidence.length ? `\n\n${quote(evidence.join("\n"))}` : ""}`,
			);
		}
	}
	return `${sections.join("\n\n")}\n`;
}
