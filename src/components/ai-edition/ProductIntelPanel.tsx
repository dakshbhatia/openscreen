import { ArrowUpRight, Check, Download, LoaderCircle, ScanEye, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	DEFAULT_INTEL_SETTINGS,
	type IntelReport,
	type IntelSettings,
	PRODUCT_ANALYST_PROMPT,
	type ProductDecision,
	type ProductReadoutInsight,
} from "@/lib/product-intel";
import {
	getReportCompanyContext,
	reportToExportData,
	reportToMarkdown,
} from "@/lib/product-intel-export";
import { nativeBridgeClient } from "@/native/client";
import styles from "./ProductIntelPanel.module.css";

interface Props {
	open: boolean;
	embedded?: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string | null;
	source: { assetId: string; path: string; durationSec: number } | null;
	freshRecordingProjectId: string | null;
}
const LENSES = [
	{ label: "Whole product flow", prompt: PRODUCT_ANALYST_PROMPT },
	{
		label: "Onboarding & activation",
		prompt: `${PRODUCT_ANALYST_PROMPT}\nFocus on first value, setup burden, empty states, defaults and progressive disclosure.`,
	},
	{
		label: "Pricing & upgrades",
		prompt: `${PRODUCT_ANALYST_PROMPT}\nFocus on visible usage limits, pricing gates, upgrade placement, value framing and cancellation. Do not infer willingness to pay.`,
	},
];
const message = (error: unknown) =>
	(error instanceof Error ? error.message : "Something went wrong. Please retry.").replace(
		/AIza[\w-]{35}/g,
		"[redacted]",
	);
const timecode = (seconds: number) =>
	`${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function ProductIntelPanel({
	open,
	embedded = false,
	onOpenChange,
	projectId,
	source,
	freshRecordingProjectId,
}: Props) {
	const [settings, setSettings] = useState<IntelSettings>({ ...DEFAULT_INTEL_SETTINGS });
	const [loaded, setLoaded] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [backendPending, setBackendPending] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [key, setKey] = useState("");
	const [keyError, setKeyError] = useState("");
	const [keyBusy, setKeyBusy] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [report, setReport] = useState<IntelReport | null>(null);
	const [evidenceTime, setEvidenceTime] = useState<number | null>(null);
	const [moreFindings, setMoreFindings] = useState(false);
	const [moreDecisions, setMoreDecisions] = useState(false);
	const [morePieces, setMorePieces] = useState(false);
	const [summaryExpanded, setSummaryExpanded] = useState(false);
	const video = useRef<HTMLVideoElement>(null);
	const researchSettings = useRef<HTMLDetailsElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const currentProject = useRef(projectId);
	const settingsVersion = useRef(0);
	const settingsDirty = useRef(false);

	const autoStarted = useRef<string | null>(null);
	const active = useRef(false);
	const requestVersion = useRef(0);
	const cancelRequested = useRef(false);
	const analysisStarted = useRef(false);

	// Project changes invalidate old saves as well as old analysis completions.
	useEffect(() => {
		if (currentProject.current !== projectId) {
			settingsVersion.current++;
			settingsDirty.current = false;
			setSaved(false);
		}
		currentProject.current = projectId;
		requestVersion.current++;
		active.current = false;
		setBusy(false);
		setStatus("");
		setBackendPending(null);
		cancelRequested.current = false;
		analysisStarted.current = false;
		setMoreFindings(false);
		setMoreDecisions(false);
		setMorePieces(false);
		setSummaryExpanded(false);
	}, [projectId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt explicitly retries failed snapshot loading.
	useEffect(() => {
		if (active.current && currentProject.current === projectId) return;
		if (!open && (!projectId || freshRecordingProjectId !== projectId)) return;
		let stale = false;
		const loadVersion = settingsVersion.current;
		const canLoadSettings = !settingsDirty.current;
		setLoaded(false);
		setReport(null);
		setError("");
		setEvidenceTime(null);
		void nativeBridgeClient.productIntel
			.snapshot(projectId ?? undefined)
			.then((snapshot) => {
				if (stale) return;
				if (canLoadSettings && !settingsDirty.current && loadVersion === settingsVersion.current) {
					setSettings(snapshot.settings);
				}
				setConnected(snapshot.connected);
				setReport(snapshot.report);
				if (snapshot.status && projectId) {
					active.current = true;
					setBackendPending(projectId);
					setBusy(true);
					setStatus(snapshot.status);
				}
				setLoaded(true);
			})
			.catch((err) => {
				if (!stale) setError(message(err));
			});
		return () => {
			stale = true;
		};
	}, [open, projectId, freshRecordingProjectId, loadAttempt]);

	// Reattach to an upload started before this panel mounted or this project reopened.
	useEffect(() => {
		if (!backendPending || backendPending !== projectId) return;
		let stale = false;
		const poll = setInterval(() => {
			void nativeBridgeClient.productIntel
				.snapshot(backendPending)
				.then((snapshot) => {
					if (stale || currentProject.current !== backendPending) return;
					setError("");
					if (snapshot.status) {
						setStatus(snapshot.status);
						return;
					}
					setReport(snapshot.report);
					setBackendPending(null);
					active.current = false;
					analysisStarted.current = false;
					setBusy(false);
					setStatus("");
				})
				.catch((err) => {
					if (!stale) setError(message(err));
				});
		}, 1500);
		return () => {
			stale = true;
			clearInterval(poll);
		};
	}, [backendPending, projectId]);

	const persistSettings = useCallback(async (next: IntelSettings, originProject: string | null) => {
		const version = ++settingsVersion.current;
		settingsDirty.current = true;
		setSettings(next);
		setError("");
		setSaved(false);
		try {
			const savedSettings = await nativeBridgeClient.productIntel.saveSettings(next);
			if (version !== settingsVersion.current || currentProject.current !== originProject)
				return false;
			// Only normalization comes back into local text; newer edits have their own revision.
			setSettings((previous) => ({ ...previous, companyDomain: savedSettings.companyDomain }));
			settingsDirty.current = false;
			setSaved(true);
			return true;
		} catch (err) {
			if (version === settingsVersion.current && currentProject.current === originProject) {
				setError(message(err));
			}
			return false;
		}
	}, []);

	const analyze = useCallback(
		async (automatic = false) => {
			if (!projectId || !source || active.current || !connected) return;
			active.current = true;
			cancelRequested.current = false;
			analysisStarted.current = false;
			const version = ++requestVersion.current;
			setBusy(true);
			setError("");
			setStatus("Preparing recording");
			setSaved(false);
			if (automatic) onOpenChange(true);
			const poll = setInterval(() => {
				void nativeBridgeClient.productIntel
					.snapshot(projectId)
					.then((s) => {
						if (version === requestVersion.current && s.status) setStatus(s.status);
					})
					.catch(() => {
						/* The analysis request reports connection errors. */
					});
			}, 2500);
			try {
				if (!automatic) {
					if (!(await persistSettings(settings, projectId))) return;
				}
				if (version !== requestVersion.current || currentProject.current !== projectId) return;
				if (cancelRequested.current) throw new Error("Analysis cancelled");
				analysisStarted.current = true;
				const result = await nativeBridgeClient.productIntel.analyze(projectId, automatic);
				if (version === requestVersion.current && currentProject.current === projectId) {
					setReport(result);
					setEvidenceTime(null);
					setMoreFindings(false);
					setMoreDecisions(false);
					setMorePieces(false);
					setSummaryExpanded(false);
				}
			} catch (err) {
				if (version === requestVersion.current) setError(message(err));
			} finally {
				clearInterval(poll);
				if (version === requestVersion.current) {
					active.current = false;
					analysisStarted.current = false;
					setBusy(false);
					setStatus("");
				}
			}
		},
		[projectId, source, connected, settings, onOpenChange, persistSettings],
	);

	useEffect(() => {
		if (
			!loaded ||
			settingsDirty.current ||
			!settings.autoAnalyze ||
			!connected ||
			!source ||
			source.durationSec <= 0 ||
			!projectId ||
			projectId !== freshRecordingProjectId ||
			(report?.projectId === projectId && report.assetId === source.assetId) ||
			autoStarted.current === projectId
		)
			return;
		autoStarted.current = projectId;
		void analyze(true);
	}, [
		loaded,
		settings.autoAnalyze,
		connected,
		source,
		projectId,
		freshRecordingProjectId,
		report,
		analyze,
	]);

	async function saveSettings(next = settings) {
		await persistSettings(next, projectId);
	}
	async function connect() {
		if (!key.trim()) return;
		setKeyBusy(true);
		setKeyError("");
		try {
			const result = await nativeBridgeClient.aiEdition.llmSetApiKey("google", key.trim());
			if (!result.success) throw new Error(result.error ?? "Could not save Gemini key");
			setKey("");
			setConnected(true);
		} catch (err) {
			setKeyError(message(err).split(key.trim()).join("[redacted]"));
		} finally {
			setKeyBusy(false);
		}
	}
	function seek(timeSec: number) {
		setEvidenceTime(timeSec);
		if (video.current) {
			video.current.currentTime = timeSec;
			video.current.pause();
			video.current.scrollIntoView?.({ block: "nearest" });
		}
	}
	function download(format: "json" | "markdown") {
		if (!visibleReport) return;
		const markdown = format === "markdown";
		const url = URL.createObjectURL(
			new Blob(
				[
					markdown
						? reportToMarkdown(visibleReport)
						: JSON.stringify(reportToExportData(visibleReport), null, 2),
				],
				{
					type: markdown ? "text/markdown;charset=utf-8" : "application/json",
				},
			),
		);
		const link = window.document.createElement("a");
		link.href = url;
		link.download = `product-flow-${visibleReport.projectId}.${markdown ? "md" : "json"}`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	const update = <K extends keyof IntelSettings>(field: K, value: IntelSettings[K]) => {
		settingsDirty.current = true;
		settingsVersion.current++;
		setSettings((previous) => ({ ...previous, [field]: value }));
		setSaved(false);
	};
	const visibleReport =
		report?.projectId === projectId && report.assetId === source?.assetId ? report : null;
	const companyContext = visibleReport ? getReportCompanyContext(visibleReport) : undefined;
	const analysis = visibleReport?.analysis;
	const extraFindings = analysis?.readout
		? Math.max(0, analysis.readout.strengths.length - 1) +
			Math.max(0, analysis.readout.frictions.length - 1)
		: 0;

	const contextChanged =
		visibleReport !== null &&
		((visibleReport.settings.companyDomain ?? "") !== (settings.companyDomain ?? "") ||
			visibleReport.settings.productBrief !== settings.productBrief ||
			(visibleReport.settings.researchGoal ?? "") !== (settings.researchGoal ?? "") ||
			visibleReport.settings.competitor !== settings.competitor ||
			visibleReport.settings.task !== settings.task ||
			visibleReport.settings.model !== settings.model ||
			visibleReport.settings.systemPrompt !== settings.systemPrompt);
	const keySetup = (
		<div className={styles.connection}>
			{keyError ? (
				<div role="alert" className={styles.error}>
					{keyError}
				</div>
			) : null}
			{connected ? (
				<p className={styles.fineprint}>
					<Check size={11} /> Gemini key saved
				</p>
			) : null}
			<label>
				Gemini API key
				<input
					type="password"
					ref={keyInput}
					autoComplete="off"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder={connected ? "Enter a replacement key" : "Paste your API key"}
					disabled={keyBusy || busy || !loaded}
				/>
			</label>
			<button
				type="button"
				className={styles.secondary}
				disabled={!key.trim() || keyBusy || busy || !loaded}
				onClick={() => void connect()}
			>
				{keyBusy ? "Saving…" : connected ? "Replace key" : "Connect Gemini"}
			</button>
		</div>
	);
	const renderFinding = (finding: IntelReport["analysis"]["findings"][number], index: number) => (
		<article className={styles.finding} key={`${finding.timeSec}-${index}`}>
			<div className={styles.findingMeta}>
				<span>{finding.category}</span>
				<button
					type="button"
					className={styles.textButton}
					onClick={() => seek(finding.timeSec)}
					aria-label={`View evidence at ${timecode(finding.timeSec)}`}
				>
					{timecode(finding.timeSec)} <ArrowUpRight size={12} />
				</button>
				<small>{finding.confidence} confidence</small>
			</div>
			<p>
				<strong>Observed</strong>
				{finding.observation}
			</p>
			<p className={styles.implication}>
				<strong>For our product</strong>
				{finding.implication}
			</p>
			<details className={styles.reasoning}>
				<summary>Hypothesis</summary>
				<p>{finding.hypothesis}</p>
			</details>
		</article>
	);
	function renderEvidence(title: string, times: number[]) {
		const button = (time: number) => (
			<button
				key={time}
				type="button"
				className={styles.textButton}
				aria-label={`Evidence for ${title} at ${timecode(time)}`}
				onClick={() => seek(time)}
			>
				{timecode(time)} <ArrowUpRight size={12} />
			</button>
		);
		return (
			<div className={styles.evidence}>
				{times.length ? (
					<>
						{button(times[0])}
						{times.length > 1 ? (
							<details className={styles.reasoning}>
								<summary>More evidence ({times.length - 1})</summary>
								{times.slice(1).map(button)}
							</details>
						) : null}
					</>
				) : null}
			</div>
		);
	}
	function renderInsight(insight: ProductReadoutInsight, index: number) {
		return (
			<article className={styles.insight} key={`${insight.title}-${index}`}>
				<h5>{insight.title}</h5>
				<p>{insight.reason}</p>
				<small>
					{insight.basis} · {insight.confidence} confidence
				</small>
				{renderEvidence(insight.title, insight.evidenceTimesSec)}
			</article>
		);
	}
	function renderDecision(decision: ProductDecision, index: number) {
		return (
			<article className={styles.decision} key={`${decision.title}-${index}`}>
				<small>
					{decision.recommendation} · {decision.confidence} confidence
				</small>
				<h5>{decision.title}</h5>
				<p>{decision.experiment}</p>
				<details className={styles.reasoning}>
					<summary>Why, alternatives & tradeoff</summary>
					<p>
						<strong>Why</strong>
						{decision.rationale}
					</p>
					<p>
						<strong>Counter-evidence</strong>
						{decision.counterEvidence}
					</p>
					<p>
						<strong>Tradeoff</strong>
						{decision.tradeoff}
					</p>
				</details>
				{renderEvidence(decision.title, decision.evidenceTimesSec)}
			</article>
		);
	}
	const analyzeButton = (
		<button
			type="button"
			className={styles.primary}
			disabled={!loaded || !source || source.durationSec <= 0 || busy || keyBusy}
			onClick={() => {
				if (!connected) {
					if (researchSettings.current) researchSettings.current.open = true;
					keyInput.current?.focus();
					return;
				}
				void analyze();
			}}
		>
			{busy ? <LoaderCircle size={16} className={styles.spin} /> : <Sparkles size={16} />}
			{busy ? "Analyzing…" : "Analyze flow"}
		</button>
	);
	const fullSummary =
		visibleReport && analysis?.readout ? (
			<details
				className={styles.reasoning}
				open={summaryExpanded}
				onToggle={(event) => setSummaryExpanded(event.currentTarget.open)}
			>
				<summary>Full summary</summary>
				<p>{visibleReport.analysis.summary}</p>
			</details>
		) : null;
	const journey = analysis?.journey;
	const briefContext =
		analysis?.understanding || journey ? (
			<div className={styles.understanding}>
				{analysis?.understanding ? (
					<p>
						<strong>Product</strong>
						{analysis.understanding.product}
					</p>
				) : null}
				{journey ? (
					<p className={styles.goal}>
						<strong>
							Goal{" "}
							<small>
								{journey.goalBasis === "supplied"
									? "Supplied"
									: journey.goalBasis === "inferred"
										? "Inferred from recording"
										: "Unknown"}
							</small>
						</strong>
						{journey.goal}
					</p>
				) : analysis?.understanding ? (
					<p>
						<strong>Job to be done</strong>
						{analysis.understanding.job}
					</p>
				) : null}
				{analysis?.understanding ? (
					<details className={styles.reasoning}>
						<summary>Audience & confidence</summary>
						{journey ? (
							<p>
								<strong>Job to be done</strong>
								{analysis.understanding.job}
							</p>
						) : null}
						<p>
							{analysis.understanding.audience} · {analysis.understanding.confidence} confidence
						</p>
					</details>
				) : null}
			</div>
		) : null;
	const journeyDetails = journey ? (
		<details
			className={styles.exploreJourney}
			key={`${visibleReport?.createdAt}-${visibleReport?.assetId}`}
		>
			<summary>Explore journey</summary>
			<p className={styles.fineprint}>
				{journey.coverage === "complete"
					? "Complete visible task in this recording. This does not establish the whole product journey."
					: "Partial recording. Task stages before or after this clip may be missing."}
			</p>
			<ol className={styles.stages}>
				{journey.stages.map((stage, index) => (
					<li key={`${stage.name}-${index}`}>
						<h5>{stage.name}</h5>
						<p>{stage.purpose}</p>
						{renderEvidence(stage.name, stage.evidenceTimesSec)}
					</li>
				))}
			</ol>
			<p className={styles.journeyOutcome}>
				<strong>Visible outcome</strong>
				{journey.outcome}
			</p>
		</details>
	) : null;

	const researchDetails = visibleReport ? (
		<details className={styles.reportDetails} open={!analysis?.readout}>
			<summary>Research details</summary>
			<p className={styles.fineprint}>
				{visibleReport.settings.competitor || "Unlabelled competitor"} ·{" "}
				{new Date(visibleReport.createdAt).toLocaleDateString()} · {visibleReport.settings.model}
			</p>
			{companyContext ? (
				<p className={styles.fineprint}>
					{companyContext.status === "retrieved" ? (
						<>
							Company website retrieved:{" "}
							{companyContext.sourceUrls.map((url, index) => (
								<span key={url}>
									{index ? ", " : ""}
									<a href={url} target="_blank" rel="noreferrer">
										{new URL(url).hostname}
									</a>
								</span>
							))}
						</>
					) : (
						"Company website unavailable; retrieval was not confirmed. Company fit remains provisional."
					)}
				</p>
			) : null}
			<details className={styles.more}>
				<summary>
					The journey ({visibleReport.analysis.steps.length}{" "}
					{visibleReport.analysis.steps.length === 1 ? "step" : "steps"})
				</summary>
				<ol className={styles.journey}>
					{visibleReport.analysis.steps.map((step, index) => (
						<li key={`${step.timeSec}-${index}`}>
							<button type="button" onClick={() => seek(step.timeSec)}>
								<span className={styles.time}>{timecode(step.timeSec)}</span>
								<strong>{step.action}</strong>
								<ArrowUpRight size={13} />
							</button>
							<p>{step.evidence}</p>
						</li>
					))}
				</ol>
			</details>
		</details>
	) : null;
	const content = (
		<>
			<header className={styles.header}>
				<div className={styles.mark}>
					<ScanEye size={21} />
				</div>
				<div>
					{embedded ? (
						<h2 className={styles.title}>Product intelligence</h2>
					) : (
						<DialogTitle className={styles.title}>Product intelligence</DialogTitle>
					)}
					{embedded ? (
						<p className={styles.subtitle}>Decisions grounded in your recording.</p>
					) : (
						<DialogDescription className={styles.subtitle}>
							Decisions grounded in your recording.
						</DialogDescription>
					)}
				</div>
			</header>
			<div className={styles.layout}>
				<section className={styles.context} aria-label="Product context">
					<details className={styles.advanced} ref={researchSettings}>
						<summary>Research settings</summary>
						<div className={styles.sectionHeading}>
							<h3>Product context</h3>
							{saved ? (
								<span className={styles.saved}>
									<Check size={12} /> Saved
								</span>
							) : null}
						</div>
						<label>
							Our product
							<textarea
								aria-label="Our product"
								rows={3}
								placeholder="Optional: audience, goal, or constraints the recording doesn’t show"
								value={settings.productBrief}
								onChange={(e) => update("productBrief", e.target.value)}
								onBlur={() => void saveSettings()}
								disabled={!loaded || busy}
							/>
						</label>
						<label>
							What are you trying to learn?
							<textarea
								aria-label="What are you trying to learn?"
								rows={2}
								maxLength={2000}
								placeholder="Optional research goal"
								value={settings.researchGoal ?? ""}
								onChange={(e) => update("researchGoal", e.target.value)}
								onBlur={() => void saveSettings()}
								disabled={!loaded || busy}
							/>
						</label>

						{keySetup}
						<label>
							Company domain (optional)
							<input
								aria-label="Company domain (optional)"
								inputMode="url"
								value={settings.companyDomain ?? ""}
								placeholder="company.com"
								onChange={(e) => update("companyDomain", e.target.value)}
								onBlur={() => void saveSettings()}
								disabled={!loaded || busy}
							/>
							<small>Gemini can read your public site during analysis to tailor the advice.</small>
						</label>
						<div className={styles.pair}>
							<label>
								Competitor
								<input
									value={settings.competitor}
									placeholder="Product name"
									onChange={(e) => update("competitor", e.target.value)}
									disabled={!loaded || busy}
								/>
							</label>
							<label>
								Flow
								<input
									value={settings.task}
									placeholder="e.g. First project"
									onChange={(e) => update("task", e.target.value)}
									disabled={!loaded || busy}
								/>
							</label>
						</div>
						<label>
							Focus
							<select
								value={LENSES.findIndex((lens) => lens.prompt === settings.systemPrompt)}
								onChange={(e) => update("systemPrompt", LENSES[Number(e.target.value)].prompt)}
								disabled={!loaded || busy}
							>
								<option value={-1} disabled>
									Custom prompt
								</option>
								{LENSES.map((lens, index) => (
									<option key={lens.label} value={index}>
										{lens.label}
									</option>
								))}
							</select>
						</label>
						<details className={styles.advanced}>
							<summary>Model & instructions</summary>
							<label>
								Model
								<input
									value={settings.model}
									onChange={(e) => update("model", e.target.value)}
									disabled={!loaded || busy}
								/>
							</label>
							<label>
								System prompt
								<textarea
									rows={8}
									value={settings.systemPrompt}
									onChange={(e) => update("systemPrompt", e.target.value)}
									disabled={!loaded || busy}
								/>
							</label>
							<button
								type="button"
								className={styles.textButton}
								disabled={!loaded || busy}
								onClick={() => update("systemPrompt", PRODUCT_ANALYST_PROMPT)}
							>
								Reset analyst prompt
							</button>
						</details>
						<label className={styles.toggle}>
							<input
								type="checkbox"
								checked={settings.autoAnalyze}
								disabled={!loaded || busy || !connected}
								onChange={(e) => void saveSettings({ ...settings, autoAnalyze: e.target.checked })}
							/>
							<span>
								Analyze after recording<small>Send each new take to Gemini.</small>
							</span>
						</label>
						<button
							type="button"
							className={styles.secondary}
							disabled={!loaded || busy}
							onClick={() => void saveSettings()}
						>
							{saved ? <Check size={14} /> : null}
							{saved ? "Saved" : "Save context"}
						</button>
						<p className={styles.fineprint}>
							Sends this recording and context to Google using your API quota. Reports stay on this
							Mac.
						</p>
					</details>
					{error ? (
						<div role="alert" className={styles.error}>
							{error}
							{!loaded ? (
								<button
									type="button"
									className={styles.textButton}
									onClick={() => setLoadAttempt((attempt) => attempt + 1)}
								>
									Retry setup
								</button>
							) : null}
						</div>
					) : null}
					{!visibleReport ? <div className={styles.actions}>{analyzeButton}</div> : null}
				</section>
				<section className={styles.report} aria-label="Product analysis">
					<div className={styles.sectionHeading}>
						<h3>{analysis?.readout ? "Product brief" : "Takeaways"}</h3>
						{visibleReport ? (
							<details className={styles.reportMore}>
								<summary aria-label="More report actions">More</summary>
								<div className={styles.exports}>
									{analysis?.readout ? (
										<>
											{fullSummary}
											{researchDetails}
										</>
									) : null}
									<button
										type="button"
										className={styles.textButton}
										onClick={() => download("markdown")}
									>
										<Download size={13} /> Markdown
									</button>
									<button
										type="button"
										className={styles.textButton}
										onClick={() => download("json")}
									>
										JSON
									</button>
									{analyzeButton}
								</div>
							</details>
						) : null}
					</div>
					{busy ? (
						<div role="status" className={styles.progress}>
							<LoaderCircle size={22} className={styles.spin} />
							<p>{status}</p>
							<button
								type="button"
								className={styles.textButton}
								onClick={() => {
									cancelRequested.current = true;
									if (projectId && (analysisStarted.current || backendPending)) {
										void nativeBridgeClient.productIntel
											.cancel(projectId)
											.catch((err) => setError(message(err)));
									}
								}}
							>
								Cancel analysis
							</button>
						</div>
					) : null}
					{!busy && !visibleReport ? (
						<div className={styles.empty}>
							<ScanEye size={30} strokeWidth={1} />
							<h3>{!source ? "Choose a recording" : "Ready to analyze"}</h3>
							<p>
								{!source
									? "Record or import a product flow to begin."
									: "Analyze the recording to find product patterns and next steps."}
							</p>
						</div>
					) : null}
					{visibleReport ? (
						<>
							{contextChanged ? (
								<div role="note" className={styles.contextChanged}>
									Context changed. Analyze again to update these takeaways.
								</div>
							) : null}
							{!analysis?.readout ? (
								<>
									<p className={styles.summary}>{visibleReport.analysis.summary}</p>
									{briefContext}
									{journeyDetails}
									{researchDetails}
								</>
							) : null}
							{analysis?.readout ? (
								<>
									{analysis.pieces?.length ? (
										<section className={styles.pieces} aria-label="Product pieces">
											<p className={styles.fineprint}>Product pieces · {analysis.pieces.length}</p>
											<div id="recording-product-pieces">
												{analysis.pieces
													.slice(0, morePieces ? analysis.pieces.length : 4)
													.map((piece, index) => (
														<button
															type="button"
															key={`${piece.name}-${index}`}
															aria-label={`View ${piece.name} at ${timecode(piece.timeSec)}`}
															onClick={() => seek(piece.timeSec)}
														>
															<span className={styles.time}>
																{timecode(piece.timeSec)} <ArrowUpRight size={12} />
															</span>
															<strong>{piece.name}</strong>
															<p>{piece.purpose}</p>
														</button>
													))}
											</div>
											{analysis.pieces.length > 4 ? (
												<button
													type="button"
													className={styles.textButton}
													aria-expanded={morePieces}
													aria-controls="recording-product-pieces"
													onClick={() => setMorePieces((shown) => !shown)}
												>
													{morePieces
														? "Fewer pieces"
														: `More pieces (${analysis.pieces.length - 4})`}
												</button>
											) : null}
										</section>
									) : null}
									{briefContext}
									{journeyDetails}
									<div className={styles.readout}>
										<section aria-label="Works well">
											<h4>Works well</h4>
											{analysis.readout.strengths.length ? (
												analysis.readout.strengths.slice(0, moreFindings ? 3 : 1).map(renderInsight)
											) : (
												<p className={styles.fineprint}>
													No supported strengths in this recording.
												</p>
											)}
										</section>
										<section aria-label="Creates friction">
											<h4>Creates friction</h4>
											{analysis.readout.frictions.length ? (
												analysis.readout.frictions.slice(0, moreFindings ? 3 : 1).map(renderInsight)
											) : (
												<p className={styles.fineprint}>No supported friction in this recording.</p>
											)}
										</section>
									</div>
									{extraFindings ? (
										<button
											type="button"
											className={styles.textButton}
											aria-expanded={moreFindings}
											onClick={() => setMoreFindings((shown) => !shown)}
										>
											{moreFindings ? "Fewer findings" : `More findings (${extraFindings})`}
										</button>
									) : null}
									<h4 className={styles.nextHeading}>Recommended next step</h4>
									{analysis.decisions?.length ? (
										analysis.decisions.slice(0, moreDecisions ? 3 : 1).map(renderDecision)
									) : (
										<p className={styles.fineprint}>No supported product decision yet.</p>
									)}
									{analysis.decisions && analysis.decisions.length > 1 ? (
										<button
											type="button"
											className={styles.textButton}
											aria-expanded={moreDecisions}
											onClick={() => setMoreDecisions((shown) => !shown)}
										>
											{moreDecisions
												? "Fewer decisions"
												: `More decisions (${analysis.decisions.length - 1})`}
										</button>
									) : null}

									<button
										type="button"
										className={styles.textButton}
										onClick={() => (evidenceTime === null ? seek(0) : setEvidenceTime(null))}
									>
										{evidenceTime === null ? "View recording" : "Hide recording"}
									</button>
								</>
							) : (
								<>
									{visibleReport.analysis.findings.slice(0, 1).map(renderFinding)}
									{visibleReport.analysis.findings.length > 1 ? (
										<details className={styles.more}>
											<summary>
												More findings ({visibleReport.analysis.findings.length - 1})
											</summary>
											{visibleReport.analysis.findings.slice(1).map(renderFinding)}
										</details>
									) : null}
								</>
							)}
							{source && (!analysis?.readout || evidenceTime !== null) ? (
								<video
									ref={video}
									className={styles.video}
									src={toFileUrl(source.path)}
									controls
									preload="metadata"
									aria-label="Source recording"
									onLoadedMetadata={() => {
										if (video.current && evidenceTime !== null) {
											video.current.currentTime = evidenceTime;
											video.current.scrollIntoView?.({ block: "nearest" });
										}
									}}
								/>
							) : null}
							{visibleReport.analysis.unknowns.length ? (
								<details className={styles.unknowns}>
									<summary>Unknowns ({visibleReport.analysis.unknowns.length})</summary>
									<ul>
										{visibleReport.analysis.unknowns.map((item, index) => (
											<li key={`${index}-${item}`}>{item}</li>
										))}
									</ul>
								</details>
							) : null}
							{!visibleReport.remoteFileDeleted ? (
								<p className={styles.error}>
									Google file cleanup was not confirmed. The temporary upload expires under Google’s
									Files retention policy.
								</p>
							) : null}
						</>
					) : null}
				</section>
			</div>
		</>
	);
	if (embedded)
		return open ? (
			<section className={`${styles.panel} ${styles.embedded}`} aria-label="Product intelligence">
				{content}
			</section>
		) : null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className={styles.panel}>{content}</DialogContent>
		</Dialog>
	);
}
