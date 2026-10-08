import { ArrowUpRight, Check, Download, LoaderCircle, ScanEye, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	DEFAULT_INTEL_SETTINGS,
	type IntelReport,
	type IntelSettings,
	PRODUCT_ANALYST_PROMPT,
} from "@/lib/product-intel";
import { reportToMarkdown } from "@/lib/product-intel-export";
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
	const video = useRef<HTMLVideoElement>(null);
	const researchSettings = useRef<HTMLDetailsElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const currentProject = useRef(projectId);

	const autoStarted = useRef<string | null>(null);
	const active = useRef(false);
	const requestVersion = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt explicitly retries failed snapshot loading.
	useEffect(() => {
		if (active.current && currentProject.current === projectId) return;
		if (!open && (!projectId || freshRecordingProjectId !== projectId)) return;
		let stale = false;
		setLoaded(false);
		setReport(null);
		setError("");
		setEvidenceTime(null);
		void nativeBridgeClient.productIntel
			.snapshot(projectId ?? undefined)
			.then((snapshot) => {
				if (stale) return;
				setSettings(snapshot.settings);
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

	// Long uploads continue when the panel closes. A project change must not let an
	// old completion replace the next project's report or trigger its auto-analysis.
	useEffect(() => {
		currentProject.current = projectId;
		requestVersion.current++;
		active.current = false;
		setBusy(false);
		setStatus("");
		setBackendPending(null);
	}, [projectId]);

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

	const analyze = useCallback(
		async (automatic = false) => {
			if (!projectId || !source || active.current || !connected) return;
			active.current = true;
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
				if (!automatic) await nativeBridgeClient.productIntel.saveSettings(settings);
				const result = await nativeBridgeClient.productIntel.analyze(projectId, automatic);
				if (version === requestVersion.current && currentProject.current === projectId) {
					setReport(result);
					setEvidenceTime(null);
				}
			} catch (err) {
				if (version === requestVersion.current) setError(message(err));
			} finally {
				clearInterval(poll);
				if (version === requestVersion.current) {
					active.current = false;
					setBusy(false);
					setStatus("");
				}
			}
		},
		[projectId, source, connected, settings, onOpenChange],
	);

	useEffect(() => {
		if (
			!loaded ||
			!settings.autoAnalyze ||
			!connected ||
			!source ||
			source.durationSec <= 0 ||
			!projectId ||
			projectId !== freshRecordingProjectId ||
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
		analyze,
	]);

	async function saveSettings(next = settings) {
		setError("");
		setSaved(false);
		try {
			const savedSettings = await nativeBridgeClient.productIntel.saveSettings(next);
			setSettings(savedSettings);
			setSaved(true);
		} catch (err) {
			setError(message(err));
		}
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
						: JSON.stringify(
								{
									projectId: visibleReport.projectId,
									assetId: visibleReport.assetId,
									createdAt: visibleReport.createdAt,
									durationSec: visibleReport.durationSec,
									sourceFingerprint: visibleReport.sourceFingerprint,
									remoteFileDeleted: visibleReport.remoteFileDeleted,
									context: {
										productBrief: visibleReport.settings.productBrief,
										competitor: visibleReport.settings.competitor,
										task: visibleReport.settings.task,
										model: visibleReport.settings.model,
									},
									analysis: visibleReport.analysis,
								},
								null,
								2,
							),
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
		setSettings((previous) => ({ ...previous, [field]: value }));
		setSaved(false);
	};
	const visibleReport =
		report?.projectId === projectId && report.assetId === source?.assetId ? report : null;

	const contextChanged =
		visibleReport !== null &&
		(visibleReport.settings.productBrief !== settings.productBrief ||
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
							placeholder="Audience, goal, and what makes our approach different"
							value={settings.productBrief}
							onChange={(e) => update("productBrief", e.target.value)}
							onBlur={() => void saveSettings()}
							disabled={!loaded || busy}
						/>
					</label>
					<details className={styles.advanced} ref={researchSettings}>
						<summary>Research settings</summary>
						{keySetup}
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
					<div className={styles.actions}>
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
					</div>
				</section>
				<section className={styles.report} aria-label="Product analysis">
					<div className={styles.sectionHeading}>
						<h3>Takeaways</h3>
						{visibleReport ? (
							<div className={styles.exports}>
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
							</div>
						) : null}
					</div>
					{busy ? (
						<div role="status" className={styles.progress}>
							<LoaderCircle size={22} className={styles.spin} />
							<p>{status}</p>
							<button
								type="button"
								className={styles.textButton}
								onClick={() =>
									projectId &&
									void nativeBridgeClient.productIntel
										.cancel(projectId)
										.catch((err) => setError(message(err)))
								}
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
									: "Add your product context to make the takeaways relevant."}
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
							<p className={styles.summary}>{visibleReport.analysis.summary}</p>
							<p className={styles.fineprint}>
								{visibleReport.settings.competitor || "Unlabelled competitor"} ·{" "}
								{new Date(visibleReport.createdAt).toLocaleDateString()} ·{" "}
								{visibleReport.settings.model}
							</p>
							{visibleReport.analysis.findings.slice(0, 3).map(renderFinding)}
							{visibleReport.analysis.findings.length > 3 ? (
								<details className={styles.more}>
									<summary>More findings ({visibleReport.analysis.findings.length - 3})</summary>
									{visibleReport.analysis.findings.slice(3).map(renderFinding)}
								</details>
							) : null}
							{source ? (
								<video
									ref={video}
									className={styles.video}
									src={toFileUrl(source.path)}
									controls
									preload="metadata"
									aria-label="Source recording"
									onLoadedMetadata={() => {
										if (video.current && evidenceTime !== null)
											video.current.currentTime = evidenceTime;
									}}
								/>
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
