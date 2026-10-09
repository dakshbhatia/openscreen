import {
	Camera,
	Check,
	ChevronLeft,
	ChevronRight,
	FolderOpen,
	Images,
	LoaderCircle,
	Search,
	Sparkles,
	Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { DEFAULT_INTEL_SETTINGS, type IntelSettings } from "@/lib/product-intel";
import type {
	ScreenshotBatch,
	ScreenshotDecision,
	ScreenshotReadoutInsight,
} from "@/lib/screenshot-intel";
import { nativeBridgeClient } from "@/native/client";
import { getPlatform } from "@/utils/platformUtils";
import styles from "./ScreenshotBoard.module.css";

type CaptureAccessStatus = "granted" | "not-determined" | "denied" | "restricted" | "unknown";

interface Props {
	active: boolean;
}
const message = (error: unknown) =>
	shareText(error instanceof Error ? error.message : "Could not complete this request. Retry.");

function researchLabel(batch: ScreenshotBatch): string {
	const purposes = [...new Set(batch.analysis?.screens.map((screen) => screen.group) ?? [])];
	const title = purposes.length ? purposes.slice(0, 2).join(" / ") : batch.title;
	return `${title} · ${batch.images.length} ${batch.images.length === 1 ? "screen" : "screens"} · ${new Date(batch.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}${batch.analysis ? "" : " · Unanalyzed"}`;
}

function shareText(value: string): string {
	return value
		.replace(/AIza[\w-]{35}/g, "[redacted]")
		.replace(/file:\/\/[^\s<>"`]+/gi, "[redacted]")
		.replace(/(?:[A-Za-z]:\\|\\\\)[^\s<>"`]+/g, "[redacted]")
		.replace(/(?<![\w:/])\/(?:Users|home|private|Volumes|tmp)\/[^\s<>"`]+/g, "[redacted]");
}
function shareInsight(insight: ScreenshotReadoutInsight) {
	return {
		title: shareText(insight.title),
		reason: shareText(insight.reason),
		basis: insight.basis,
		confidence: insight.confidence,
		evidenceImageIds: insight.evidenceImageIds,
	};
}

function shareableBatch(batch: ScreenshotBatch) {
	return {
		id: batch.id,
		title: shareText(batch.title),
		createdAt: batch.createdAt,
		analyzedAt: batch.analyzedAt,
		context: batch.settings
			? {
					productBrief: shareText(batch.settings.productBrief),
					companyDomain: batch.settings.companyDomain,
					competitor: shareText(batch.settings.competitor),
					researchGoal: shareText(batch.settings.researchGoal ?? ""),
					task: shareText(batch.settings.task),
					model: batch.settings.model,
				}
			: undefined,
		companyContext: batch.companyContext
			? {
					domain: batch.companyContext.domain,
					status: batch.companyContext.status,
					sourceUrls: batch.companyContext.sourceUrls,
				}
			: undefined,
		images: batch.images.map(({ id, originalName, mimeType, width, height }) => ({
			id,
			originalName: shareText(originalName),
			mimeType,
			width,
			height,
		})),
		analysis: batch.analysis
			? {
					summary: shareText(batch.analysis.summary),
					understanding: batch.analysis.understanding
						? {
								product: shareText(batch.analysis.understanding.product),
								audience: shareText(batch.analysis.understanding.audience),
								job: shareText(batch.analysis.understanding.job),
								confidence: batch.analysis.understanding.confidence,
							}
						: undefined,
					journey: batch.analysis.journey
						? {
								goal: shareText(batch.analysis.journey.goal),
								goalBasis: batch.analysis.journey.goalBasis,
								outcome: shareText(batch.analysis.journey.outcome),
								coverage: batch.analysis.journey.coverage,
								stages: batch.analysis.journey.stages.map((stage) => ({
									name: shareText(stage.name),
									purpose: shareText(stage.purpose),
									evidenceImageIds: stage.evidenceImageIds,
								})),
							}
						: undefined,
					readout: batch.analysis.readout
						? {
								strengths: batch.analysis.readout.strengths.map(shareInsight),
								frictions: batch.analysis.readout.frictions.map(shareInsight),
							}
						: undefined,
					decisions: batch.analysis.decisions?.map((decision) => ({
						title: shareText(decision.title),
						recommendation: decision.recommendation,
						rationale: shareText(decision.rationale),
						counterEvidence: shareText(decision.counterEvidence),
						experiment: shareText(decision.experiment),
						tradeoff: shareText(decision.tradeoff),
						confidence: decision.confidence,
						evidenceImageIds: decision.evidenceImageIds,
					})),
					screens: batch.analysis.screens.map((screen) => ({
						imageId: screen.imageId,
						label: shareText(screen.label),
						group: shareText(screen.group),
						purpose: screen.purpose ? shareText(screen.purpose) : undefined,
						observation: shareText(screen.observation),
						hypothesis: shareText(screen.hypothesis),
						advice: shareText(screen.advice),
						confidence: screen.confidence,
					})),
					unknowns: batch.analysis.unknowns.map(shareText),
				}
			: null,
	};
}

export function ScreenshotBoard({ active }: Props) {
	const [settings, setSettings] = useState<IntelSettings>({ ...DEFAULT_INTEL_SETTINGS });
	const [connected, setConnected] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [key, setKey] = useState("");
	const [keyError, setKeyError] = useState("");
	const [batch, setBatch] = useState<ScreenshotBatch | null>(null);
	const [recent, setRecent] = useState<ScreenshotBatch[]>([]);
	const [busy, setBusy] = useState<"import" | "analyze" | "organize" | "key" | null>(null);
	const [error, setError] = useState("");
	const [captureAccess, setCaptureAccess] = useState<CaptureAccessStatus | null>(null);
	const [captureAccessBusy, setCaptureAccessBusy] = useState(false);
	const [captureAccessError, setCaptureAccessError] = useState("");
	const [dragging, setDragging] = useState(false);
	const [selectedImage, setSelectedImage] = useState<string | null>(null);
	const [libraryOpen, setLibraryOpen] = useState(false);
	const [libraryPage, setLibraryPage] = useState(0);
	const [query, setQuery] = useState("");
	const [groupFilter, setGroupFilter] = useState("");
	const [contextExpanded, setContextExpanded] = useState(false);
	const [contextSave, setContextSave] = useState<"saved" | "saving" | "unsaved" | null>(null);
	const [contextError, setContextError] = useState("");
	const [summaryExpanded, setSummaryExpanded] = useState(false);
	const [showAllDecisions, setShowAllDecisions] = useState(false);
	const [showAllFindings, setShowAllFindings] = useState(false);
	const [showLegacyAdvice, setShowLegacyAdvice] = useState(false);
	const [journeyExpanded, setJourneyExpanded] = useState(false);
	const [decisionEvidenceIds, setDecisionEvidenceIds] = useState<string[] | null>(null);
	const working = useRef(false);
	const captureChecking = useRef(false);
	const captureRequest = useRef(0);
	const cancelRequested = useRef(false);
	const analysisStarted = useRef(false);
	const more = useRef<HTMLDetailsElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const settingsDirty = useRef(false);
	const settingsVersion = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt retries unavailable setup.
	useEffect(() => {
		if (!active || working.current) return;
		let stale = false;
		const loadVersion = settingsVersion.current;
		const canLoadSettings = !settingsDirty.current;
		setError("");
		setLoaded(false);
		void Promise.all([
			nativeBridgeClient.productIntel.snapshot(),
			nativeBridgeClient.screenshotIntel.list(),
		])
			.then(([snapshot, batches]) => {
				if (stale) return;
				if (canLoadSettings && !settingsDirty.current && loadVersion === settingsVersion.current) {
					setSettings(snapshot.settings);
				}
				setConnected(snapshot.connected);
				setRecent(batches);
				setBatch((previous) => previous ?? batches[0] ?? null);
				setLoaded(true);
			})
			.catch((err) => {
				if (!stale) setError(message(err));
			});
		return () => {
			stale = true;
		};
	}, [active, loadAttempt]);

	useEffect(() => {
		if (!active) setSelectedImage(null);
	}, [active]);

	function update<K extends keyof IntelSettings>(field: K, value: IntelSettings[K]) {
		settingsDirty.current = true;
		settingsVersion.current++;
		setContextSave("unsaved");
		setSettings((previous) => ({ ...previous, [field]: value }));
	}
	function remember(next: ScreenshotBatch) {
		if (next.id !== batch?.id) {
			setLibraryOpen(false);
			setLibraryPage(0);
			setQuery("");
			setGroupFilter("");
		} else if (
			groupFilter &&
			!next.analysis?.screens.some((screen) => screen.group === groupFilter)
		) {
			setLibraryPage(0);
			setGroupFilter("");
		}
		setSummaryExpanded(false);
		setShowAllDecisions(false);
		setShowAllFindings(false);
		setShowLegacyAdvice(false);
		setJourneyExpanded(false);
		setDecisionEvidenceIds(null);
		setBatch(next);
		setSelectedImage(null);
		setRecent((previous) => [next, ...previous.filter((item) => item.id !== next.id)]);
	}
	const saveContext = useCallback(async () => {
		if (!settingsDirty.current || !loaded || busy) return;
		const version = settingsVersion.current;
		setContextSave("saving");
		try {
			const saved = await nativeBridgeClient.productIntel.saveSettings(settings);
			if (version === settingsVersion.current) {
				setSettings((previous) => ({ ...previous, companyDomain: saved.companyDomain }));
				settingsDirty.current = false;
				setContextSave("saved");
				setContextError("");
			}
		} catch (err) {
			if (version === settingsVersion.current) {
				setContextSave("unsaved");
				setContextError(message(err));
			}
		}
	}, [settings, loaded, busy]);
	useEffect(() => {
		if (!active || !loaded || busy || !settingsDirty.current) return;
		const timer = setTimeout(() => void saveContext(), 450);
		return () => clearTimeout(timer);
	}, [active, loaded, busy, saveContext]);
	async function run(
		kind: "import" | "analyze" | "organize",
		action: () => Promise<ScreenshotBatch | null>,
		analyzeImported = false,
	) {
		if (working.current || captureChecking.current) return;
		working.current = true;
		cancelRequested.current = false;
		analysisStarted.current = false;
		setBusy(kind);
		setError("");
		try {
			const result = await action();
			if (result) {
				remember(result);
				if (analyzeImported && connected) {
					setBusy("analyze");
					const saved = await nativeBridgeClient.productIntel.saveSettings(settings);
					setSettings((previous) => ({ ...previous, companyDomain: saved.companyDomain }));
					settingsDirty.current = false;
					setContextSave("saved");
					setContextError("");
					if (cancelRequested.current) throw new Error("Analysis cancelled");
					analysisStarted.current = true;
					remember(await nativeBridgeClient.screenshotIntel.analyze(result.id));
				}
			}
		} catch (err) {
			setError(message(err));
		} finally {
			working.current = false;
			analysisStarted.current = false;
			setBusy(null);
		}
	}
	const checkCaptureAccess = useCallback(
		async (showGranted = true): Promise<CaptureAccessStatus | null> => {
			if (!active || !loaded || working.current || captureChecking.current) return null;
			const request = ++captureRequest.current;
			captureChecking.current = true;
			setCaptureAccessBusy(true);
			setCaptureAccessError("");
			try {
				const result = await nativeBridgeClient.screenshotIntel.captureAccess();
				if (request !== captureRequest.current) return null;
				if (result.status !== "granted" || showGranted) setCaptureAccess(result.status);
				return result.status;
			} catch {
				if (request === captureRequest.current) {
					setCaptureAccess("unknown");
					setCaptureAccessError(
						"Couldn’t check screen access. Open System Settings, then check again.",
					);
				}
				return null;
			} finally {
				if (request === captureRequest.current) {
					captureChecking.current = false;
					setCaptureAccessBusy(false);
				}
			}
		},
		[active, loaded],
	);
	const showCaptureAccess = captureAccess !== null;
	useEffect(() => {
		if (!active || !showCaptureAccess) return;
		const onFocus = () => void checkCaptureAccess();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [active, showCaptureAccess, checkCaptureAccess]);
	useEffect(() => {
		if (!active) {
			captureRequest.current++;
			captureChecking.current = false;
			setCaptureAccessBusy(false);
		}
		return () => {
			captureRequest.current++;
		};
	}, [active]);
	function dismissCaptureAccess() {
		captureRequest.current++;
		captureChecking.current = false;
		setCaptureAccessBusy(false);
		setCaptureAccess(null);
		setCaptureAccessError("");
	}
	async function takeScreenshot() {
		if ((await checkCaptureAccess(false)) !== "granted") return;
		setCaptureAccess(null);
		await run(
			"import",
			async () => {
				try {
					return await nativeBridgeClient.screenshotIntel.capture();
				} catch {
					setCaptureAccess("unknown");
					setCaptureAccessError(
						"Screen capture couldn’t start. Check access or use screenshots instead.",
					);
					return null;
				}
			},
			true,
		);
	}
	async function openCaptureSettings() {
		if (working.current || captureChecking.current) return;
		const request = ++captureRequest.current;
		captureChecking.current = true;
		setCaptureAccessBusy(true);
		setCaptureAccessError("");
		try {
			await nativeBridgeClient.screenshotIntel.openCaptureSettings();
		} catch {
			if (request === captureRequest.current)
				setCaptureAccessError(
					"Couldn’t open System Settings. Open Privacy & Security → Screen Recording, then check access here.",
				);
		} finally {
			if (request === captureRequest.current) {
				captureChecking.current = false;
				setCaptureAccessBusy(false);
			}
		}
	}
	async function connect() {
		if (!key.trim() || working.current) return;
		working.current = true;
		setBusy("key");
		setKeyError("");
		try {
			const result = await nativeBridgeClient.aiEdition.llmSetApiKey("google", key.trim());
			if (!result.success) throw new Error(result.error ?? "Could not save Gemini key");
			setKey("");
			setConnected(true);
		} catch (err) {
			setKeyError(message(err).split(key.trim()).join("[redacted]"));
		} finally {
			working.current = false;
			setBusy(null);
		}
	}
	function analyze() {
		if (!batch || !loaded) return;
		if (!connected) {
			if (more.current) more.current.open = true;
			keyInput.current?.focus();
			return;
		}
		void run("analyze", async () => {
			const saved = await nativeBridgeClient.productIntel.saveSettings(settings);
			setSettings((previous) => ({ ...previous, companyDomain: saved.companyDomain }));
			settingsDirty.current = false;
			setContextSave("saved");
			setContextError("");
			if (cancelRequested.current) throw new Error("Analysis cancelled");
			analysisStarted.current = true;
			return nativeBridgeClient.screenshotIntel.analyze(batch.id);
		});
	}
	function download(format: "markdown" | "json") {
		if (!batch) return;
		const shared = shareableBatch(batch);
		const evidenceLabels = (ids: string[]) =>
			ids
				.map((id) => {
					const label = shared.analysis?.screens.find((screen) => screen.imageId === id)?.label;
					return label ? `${id} (${label})` : id;
				})
				.join(", ");
		const text =
			format === "json"
				? JSON.stringify(shared, null, 2)
				: [
						`# ${shared.title}`,
						shared.analysis?.summary ?? "",
						...(shared.context
							? [
									"## Product context",
									shared.context.productBrief,
									`Company domain: ${shared.context.companyDomain || "Not supplied"}`,
									`Competitor: ${shared.context.competitor}`,
									`Research goal: ${shared.context.researchGoal || "Not supplied"}`,
									`Attempted task: ${shared.context.task || "Not supplied"}`,
								]
							: []),
						...(shared.companyContext
							? [
									`Company website: ${shared.companyContext.status === "retrieved" ? "retrieved" : "not retrieved"}`,
									...shared.companyContext.sourceUrls,
								]
							: []),
						...(shared.analysis?.understanding
							? [
									"## Working understanding",
									`Product: ${shared.analysis.understanding.product}`,
									`Audience: ${shared.analysis.understanding.audience}`,
									`Job: ${shared.analysis.understanding.job}`,
									`Confidence: ${shared.analysis.understanding.confidence}`,
								]
							: []),
						...(shared.analysis?.journey
							? [
									"## Product pieces",
									"Unordered screenshot map. Sequence and task completion are unverified.",
									`Goal: ${shared.analysis.journey.goal}`,
									`Goal basis: ${shared.analysis.journey.goalBasis}`,
									`Coverage: ${shared.analysis.journey.coverage}`,
									`Visible outcome: ${shared.analysis.journey.outcome}`,
									...shared.analysis.journey.stages.flatMap((stage) => [
										`### ${stage.name}`,
										`Purpose: ${stage.purpose}`,
										`Evidence: ${evidenceLabels(stage.evidenceImageIds)}`,
									]),
								]
							: []),
						...(shared.analysis?.readout
							? [
									"## Works well",
									...shared.analysis.readout.strengths.flatMap((insight) => [
										`### ${insight.title}`,
										insight.reason,
										`${insight.basis} · ${insight.confidence} confidence`,
										`Evidence: ${evidenceLabels(insight.evidenceImageIds)}`,
									]),
									"## Creates friction",
									...shared.analysis.readout.frictions.flatMap((insight) => [
										`### ${insight.title}`,
										insight.reason,
										`${insight.basis} · ${insight.confidence} confidence`,
										`Evidence: ${evidenceLabels(insight.evidenceImageIds)}`,
									]),
								]
							: []),
						...(shared.analysis?.decisions?.flatMap((decision) => [
							`## ${decision.recommendation}: ${decision.title}`,
							`Why: ${decision.rationale}`,
							`Counterevidence / alternative: ${decision.counterEvidence}`,
							`Experiment: ${decision.experiment}`,
							`Tradeoff: ${decision.tradeoff}`,
							`Confidence: ${decision.confidence}`,
							`Evidence: ${evidenceLabels(decision.evidenceImageIds)}`,
						]) ?? []),
						...(shared.analysis?.screens.flatMap((screen) => [
							`## ${screen.group} / ${screen.label}`,
							`Screen ID: ${screen.imageId}`,
							...(screen.purpose ? [`Purpose: ${screen.purpose}`] : []),
							`Observed: ${screen.observation}`,
							`Hypothesis (${screen.confidence} confidence): ${screen.hypothesis}`,
							`For our product: ${screen.advice}`,
						]) ?? []),
						...(shared.analysis?.unknowns.length
							? ["## Unknowns", ...shared.analysis.unknowns.map((item) => `- ${item}`)]
							: []),
					].join("\n\n");
		const url = URL.createObjectURL(
			new Blob([text], {
				type: format === "json" ? "application/json" : "text/markdown;charset=utf-8",
			}),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = `screenshot-research-${batch.id}.${format === "json" ? "json" : "md"}`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	const analysis = batch?.analysis;
	const decisionLimit = 1;
	const contextChanged =
		batch?.settings &&
		(batch.settings.productBrief !== settings.productBrief ||
			batch.settings.companyDomain !== settings.companyDomain ||
			batch.settings.competitor !== settings.competitor ||
			batch.settings.task !== settings.task ||
			(batch.settings.researchGoal ?? "") !== (settings.researchGoal ?? "") ||
			batch.settings.model !== settings.model ||
			batch.settings.systemPrompt !== settings.systemPrompt);
	const groups = new Map<string, ScreenshotBatch["images"]>();
	const allGroups = [...new Set(analysis?.screens.map((screen) => screen.group) ?? [])];
	const overviewGroups = allGroups.flatMap((group) => {
		const images = (batch?.images ?? []).filter((image) =>
			analysis?.screens.some((screen) => screen.imageId === image.id && screen.group === group),
		);
		return images.length ? [{ group, images }] : [];
	});
	const extraFindingCount = analysis?.readout
		? Math.max(0, Math.min(3, analysis.readout.strengths.length) - 1) +
			Math.max(0, Math.min(3, analysis.readout.frictions.length) - 1)
		: 0;
	const search = query.trim().toLocaleLowerCase();
	for (const image of batch?.images ?? []) {
		const screen = analysis?.screens.find((screen) => screen.imageId === image.id);
		const group = screen?.group ?? "Screenshots";
		if (groupFilter && group !== groupFilter) continue;
		if (
			search &&
			![
				image.originalName,
				screen?.label,
				screen?.purpose,
				group,
				screen?.observation,
				screen?.hypothesis,
				screen?.advice,
				...[...(analysis?.readout?.strengths ?? []), ...(analysis?.readout?.frictions ?? [])]
					.filter((insight) => insight.evidenceImageIds.includes(image.id))
					.flatMap((insight) => [insight.title, insight.reason]),
				...(analysis?.journey?.stages
					.filter((stage) => stage.evidenceImageIds.includes(image.id))
					.flatMap((stage) => [stage.name, stage.purpose]) ?? []),
				...(analysis?.decisions
					?.filter((decision) => decision.evidenceImageIds.includes(image.id))
					.flatMap((decision) => [
						decision.title,
						decision.rationale,
						decision.experiment,
						decision.counterEvidence,
						decision.tradeoff,
					]) ?? []),
			]
				.filter(Boolean)
				.join(" ")
				.toLocaleLowerCase()
				.includes(search)
		)
			continue;
		groups.set(group, [...(groups.get(group) ?? []), image]);
	}
	const visibleImages = [...groups.values()].flat();
	const pageCount = Math.ceil(visibleImages.length / 24);
	const currentPage = Math.min(libraryPage, Math.max(0, pageCount - 1));
	const pageImages = visibleImages.slice(currentPage * 24, (currentPage + 1) * 24);
	const pageGroups = new Map<string, ScreenshotBatch["images"]>();
	for (const image of pageImages) {
		const group =
			analysis?.screens.find((screen) => screen.imageId === image.id)?.group ?? "Screenshots";
		pageGroups.set(group, [...(pageGroups.get(group) ?? []), image]);
	}
	const evidence = batch?.images.find((image) => image.id === selectedImage);
	const evidenceScreen = analysis?.screens.find((screen) => screen.imageId === selectedImage);
	const evidenceImages = decisionEvidenceIds
		? decisionEvidenceIds.flatMap((id) => batch?.images.find((image) => image.id === id) ?? [])
		: visibleImages.some((image) => image.id === selectedImage)
			? visibleImages
			: (batch?.images ?? []);
	const evidenceIndex = evidenceImages.findIndex((image) => image.id === selectedImage);
	function navigateEvidence(direction: -1 | 1) {
		const next = evidenceImages[evidenceIndex + direction];
		if (next) setSelectedImage(next.id);
	}
	function openEvidence(imageId: string, ids: string[] | null = null) {
		setDecisionEvidenceIds(ids);
		setSelectedImage(imageId);
	}
	const journeyContent = analysis?.journey ? (
		<div className={styles.journey}>
			<p className={styles.journeyGoal}>
				<strong>
					{analysis.journey.goalBasis === "inferred"
						? "Inferred goal"
						: analysis.journey.goalBasis === "supplied"
							? "Supplied goal"
							: "Goal unclear"}
				</strong>
				<span>{analysis.journey.goal}</span>
			</p>
			<button
				type="button"
				className={styles.textButton}
				aria-expanded={journeyExpanded}
				aria-controls="screenshot-product-pieces"
				onClick={() => setJourneyExpanded((expanded) => !expanded)}
			>
				{journeyExpanded ? "Hide product pieces" : "Explore product pieces"}
			</button>
			{journeyExpanded ? (
				<div id="screenshot-product-pieces">
					<p className={styles.muted}>
						Unordered screenshot map. Sequence and task completion are unverified.
					</p>
					<p className={styles.journeyOutcome}>
						<strong>Visible outcome</strong> {analysis.journey.outcome}
					</p>
					{analysis.journey.stages.length ? (
						<div className={styles.journeyPieces}>
							{analysis.journey.stages.map((stage, index) => (
								<article key={`${stage.name}-${index}`}>
									<h4>{stage.name}</h4>
									<p>{stage.purpose}</p>
									<button
										type="button"
										className={styles.evidenceLink}
										aria-label={`Evidence for product piece ${stage.name}`}
										onClick={() => openEvidence(stage.evidenceImageIds[0], stage.evidenceImageIds)}
									>
										{stage.evidenceImageIds.length}{" "}
										{stage.evidenceImageIds.length === 1 ? "screen" : "screens"}
									</button>
								</article>
							))}
						</div>
					) : (
						<p className={styles.muted}>No supported relationships between these screens.</p>
					)}
				</div>
			) : null}
		</div>
	) : null;
	function insightCard(insight: ScreenshotReadoutInsight, index: number) {
		return (
			<article key={`${index}-${insight.title}`} className={styles.insight}>
				<h4>{insight.title}</h4>
				<p>{insight.reason}</p>
				<small>
					{insight.basis} · {insight.confidence} confidence
				</small>
				<button
					type="button"
					className={styles.evidenceLink}
					onClick={() => openEvidence(insight.evidenceImageIds[0], insight.evidenceImageIds)}
					aria-label={`Evidence for ${insight.title}`}
				>
					Inspect {insight.evidenceImageIds.length}{" "}
					{insight.evidenceImageIds.length === 1 ? "source screen" : "source screens"}
				</button>
			</article>
		);
	}

	function decisionCard(decision: ScreenshotDecision, index: number) {
		return (
			<article key={`${index}-${decision.title}`} className={styles.decision}>
				<small>
					{decision.recommendation} · {decision.confidence} evidence confidence
				</small>
				<h3>{decision.title}</h3>
				<p className={styles.advicePreview}>{decision.experiment}</p>
				<details>
					<summary>Why, alternatives & tradeoff</summary>
					<p>
						<strong>Why</strong>
						{decision.rationale}
					</p>
					<p>
						<strong>Counterevidence / alternative</strong>
						{decision.counterEvidence}
					</p>
					<p>
						<strong>Experiment</strong>
						{decision.experiment}
					</p>
					<p>
						<strong>Tradeoff</strong>
						{decision.tradeoff}
					</p>
				</details>
				<button
					type="button"
					className={styles.evidenceLink}
					onClick={() => openEvidence(decision.evidenceImageIds[0], decision.evidenceImageIds)}
					aria-label={`Evidence for ${decision.title}`}
				>
					Inspect {decision.evidenceImageIds.length}{" "}
					{decision.evidenceImageIds.length === 1 ? "source screen" : "source screens"}
				</button>
			</article>
		);
	}

	return (
		<section
			className={styles.board}
			aria-label="Screenshot research"
			hidden={!active}
			onDragOver={(event) => {
				event.preventDefault();
				if (!busy && !captureAccessBusy) setDragging(true);
			}}
			onDragLeave={(event) => {
				if (
					!(event.relatedTarget instanceof Node) ||
					!event.currentTarget.contains(event.relatedTarget)
				)
					setDragging(false);
			}}
			onDrop={(event) => {
				event.preventDefault();
				setDragging(false);
				if (busy || captureAccessBusy || !loaded) return;
				const paths = Array.from(event.dataTransfer.files).map(
					(file) => window.electronAPI?.getPathForFile(file) ?? "",
				);
				if (!paths.length || paths.some((path) => !path)) {
					setError("Could not read these files. Select them with Choose screenshots.");
					return;
				}
				void run("import", () => nativeBridgeClient.screenshotIntel.import(paths), true);
			}}
		>
			<div className={`${styles.import} ${dragging ? styles.dragging : ""}`}>
				<Images size={20} />
				<span className={styles.dropCopy}>
					<span>Drop screenshots here</span>
					<small>Up to 120 PNG, JPEG or WebP images</small>
				</span>
				{getPlatform() === "darwin" && !showCaptureAccess ? (
					<button
						type="button"
						className={styles.secondary}
						disabled={!loaded || !!busy || captureAccessBusy}
						onClick={() => void takeScreenshot()}
					>
						<Camera size={14} /> Take screenshot
					</button>
				) : null}
				<button
					type="button"
					className={styles.secondary}
					disabled={!loaded || !!busy || captureAccessBusy}
					onClick={() => void run("import", () => nativeBridgeClient.screenshotIntel.pick(), true)}
				>
					<Upload size={14} /> Choose screenshots
				</button>
				<details className={styles.more} ref={more}>
					<summary>More</summary>
					<div className={styles.menu}>
						<div className={styles.contextEditor}>
							<div className={styles.contextHeading}>
								<button
									type="button"
									aria-expanded={contextExpanded}
									aria-controls="screenshot-product-context"
									onClick={() => {
										if (contextExpanded) void saveContext();
										setContextExpanded((expanded) => !expanded);
									}}
								>
									Our product <span>{contextExpanded ? "Hide" : "Edit"}</span>
								</button>
								<span className={styles.saveFeedback} aria-live="polite">
									{contextSave === "saving"
										? "Saving…"
										: contextSave === "saved"
											? "Saved"
											: contextSave === "unsaved"
												? "Unsaved changes"
												: ""}
								</span>
							</div>
							<label hidden={!contextExpanded} className={styles.companyDomain}>
								Company domain (optional)
								<input
									aria-label="Company domain (optional)"
									inputMode="url"
									placeholder="company.com"
									value={settings.companyDomain}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => update("companyDomain", event.target.value)}
									onBlur={() => void saveContext()}
								/>
								<small>
									Gemini reads your public site during analysis. Screens provide the rest.
								</small>
							</label>
							<textarea
								id="screenshot-product-context"
								aria-label="Our product"
								hidden={!contextExpanded}
								rows={2}
								placeholder="Optional: audience, decision, or constraints the screens don’t show"
								value={settings.productBrief}
								disabled={!loaded || !!busy || captureAccessBusy}
								onChange={(event) => update("productBrief", event.target.value)}
								onBlur={() => void saveContext()}
							/>
							<label hidden={!contextExpanded} className={styles.researchGoal}>
								What are you trying to learn? (optional)
								<textarea
									rows={2}
									maxLength={2000}
									value={settings.researchGoal ?? ""}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => update("researchGoal", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							{!contextExpanded ? (
								<p className={styles.contextPreview}>
									{settings.companyDomain ||
										settings.productBrief ||
										"Learns from screens · add a company domain to tailor advice"}
								</p>
							) : null}
							{contextError ? (
								<div role="alert" className={styles.error}>
									{contextError}
									<button
										type="button"
										disabled={!!busy || captureAccessBusy}
										onClick={() => void saveContext()}
									>
										Retry save
									</button>
								</div>
							) : null}
						</div>
						<div className={styles.connection}>
							{keyError ? (
								<div role="alert" className={styles.error}>
									{keyError}
								</div>
							) : null}
							{connected ? (
								<small>
									<Check size={11} /> Gemini key saved
								</small>
							) : null}
							<label>
								Gemini API key
								<input
									ref={keyInput}
									type="password"
									autoComplete="off"
									value={key}
									placeholder={connected ? "Enter a replacement key" : "Paste your API key"}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => setKey(event.target.value)}
								/>
							</label>
							<button
								type="button"
								className={styles.secondary}
								disabled={!loaded || !key.trim() || !!busy || captureAccessBusy}
								onClick={() => void connect()}
							>
								{busy === "key" ? "Saving…" : "Save Gemini key"}
							</button>
						</div>
						<label>
							Recent research
							<select
								aria-label="Recent research"
								value={batch?.id ?? ""}
								disabled={!!busy || captureAccessBusy || !recent.length}
								onChange={(event) =>
									void run("import", () =>
										nativeBridgeClient.screenshotIntel.get(event.target.value),
									)
								}
							>
								<option value="" disabled>
									Choose a batch
								</option>
								{recent.map((item) => (
									<option key={item.id} value={item.id}>
										{researchLabel(item)}
									</option>
								))}
							</select>
						</label>
						<details>
							<summary>Research settings</summary>
							<label>
								Competitor
								<input
									value={settings.competitor}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => update("competitor", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<label>
								Attempted task (optional)
								<input
									value={settings.task}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => update("task", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<label>
								Model
								<input
									value={settings.model}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => update("model", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<label>
								System prompt
								<textarea
									rows={5}
									value={settings.systemPrompt}
									disabled={!loaded || !!busy || captureAccessBusy}
									onChange={(event) => update("systemPrompt", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<p className={styles.muted}>
								Screenshots and context are sent to Google using your API quota. AI names apply to
								organized copies.
							</p>
						</details>
						{batch?.analysis ? (
							<button
								type="button"
								className={styles.secondary}
								disabled={!loaded || !!busy || captureAccessBusy}
								onClick={analyze}
							>
								<Sparkles size={14} /> Analyze again
							</button>
						) : null}
						{batch?.organizedPath ? (
							<button
								type="button"
								className={styles.secondary}
								disabled={!!busy || captureAccessBusy}
								onClick={() =>
									void nativeBridgeClient.screenshotIntel
										.reveal(batch.id)
										.catch((err) => setError(message(err)))
								}
							>
								<FolderOpen size={14} /> Open organized folder
							</button>
						) : null}
						{batch?.analysis ? (
							<div className={styles.export}>
								<button type="button" onClick={() => download("markdown")}>
									Export Markdown
								</button>
								<button type="button" onClick={() => download("json")}>
									Export JSON
								</button>
							</div>
						) : null}
						{batch?.analysis && !batch.organizedPath ? (
							<button
								type="button"
								disabled={!!busy || captureAccessBusy}
								onClick={() =>
									void run("organize", () => nativeBridgeClient.screenshotIntel.organize(batch.id))
								}
							>
								Organize copies
							</button>
						) : null}
					</div>
				</details>
			</div>
			{showCaptureAccess ? (
				<section className={styles.captureAccess} aria-label="Screen capture access">
					<h3>
						{captureAccess === "granted" ? "Screen capture is ready" : "Allow screen capture"}
					</h3>
					<p>
						{captureAccess === "granted"
							? "Access is ready. Capture a screenshot when you’re ready."
							: "macOS needs screen recording permission to take a screenshot. Allow access in System Settings → Privacy & Security → Screen Recording, then return here."}
					</p>
					{captureAccessError ? <p role="alert">{captureAccessError}</p> : null}
					<div>
						{captureAccess !== "granted" ? (
							<button
								type="button"
								className={styles.secondary}
								disabled={!!busy || captureAccessBusy}
								onClick={() => void openCaptureSettings()}
							>
								Open System Settings
							</button>
						) : null}
						<button
							type="button"
							className={styles.secondary}
							disabled={!!busy || captureAccessBusy}
							onClick={() => void takeScreenshot()}
						>
							{captureAccessBusy
								? "Checking access…"
								: captureAccess === "granted"
									? "Take screenshot"
									: "Check access & capture"}
						</button>
						<button
							type="button"
							className={styles.textButton}
							disabled={!!busy}
							onClick={dismissCaptureAccess}
						>
							Use screenshots instead
						</button>
					</div>
				</section>
			) : null}
			{batch && !analysis && !busy ? (
				<div className={styles.pendingAnalysis}>
					<button
						type="button"
						className={styles.primary}
						disabled={!loaded || !batch.images.length || captureAccessBusy}
						onClick={analyze}
					>
						<Sparkles size={14} /> Analyze screenshots
					</button>
				</div>
			) : null}
			{error ? (
				<div role="alert" className={styles.error}>
					{error}
					{!loaded ? (
						<button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
							Retry setup
						</button>
					) : null}
				</div>
			) : null}
			{busy && busy !== "key" ? (
				<div role="status" className={styles.status}>
					<LoaderCircle size={14} className={styles.spin} aria-hidden="true" />
					{busy === "analyze"
						? "Analyzing screenshots…"
						: busy === "import"
							? "Importing screenshots…"
							: busy === "organize"
								? "Organizing copies…"
								: "Organizing copies…"}
					{busy === "analyze" && batch ? (
						<button
							type="button"
							onClick={() => {
								cancelRequested.current = true;
								if (analysisStarted.current) {
									void nativeBridgeClient.screenshotIntel
										.cancel(batch.id)
										.catch((err) => setError(message(err)));
								}
							}}
						>
							Cancel
						</button>
					) : null}
				</div>
			) : null}
			{contextChanged ? (
				<div role="note" className={styles.note}>
					Context changed. Analyze again to update the advice.
				</div>
			) : null}
			{batch?.duplicatesSkipped ? (
				<p className={styles.muted}>
					{batch.duplicatesSkipped} identical{" "}
					{batch.duplicatesSkipped === 1 ? "image skipped" : "images skipped"} in this import.
					Originals are unchanged.
				</p>
			) : null}
			{overviewGroups.length ? (
				<section className={styles.groupOverview} aria-label="Screen groups">
					<p>
						{overviewGroups.length} {overviewGroups.length === 1 ? "group" : "groups"}
					</p>
					<div>
						{overviewGroups.slice(0, 4).map(({ group, images }) => {
							const image = images[0];
							const label =
								analysis?.screens.find((screen) => screen.imageId === image.id)?.label ??
								image.originalName;
							return (
								<button
									key={group}
									type="button"
									aria-label={`Browse ${group} · ${images.length} ${images.length === 1 ? "screen" : "screens"}`}
									onClick={() => {
										setQuery("");
										setGroupFilter(group);
										setLibraryPage(0);
										setLibraryOpen(true);
									}}
								>
									<img
										src={toFileUrl(image.thumbnailPath ?? image.path)}
										alt={label}
										loading="lazy"
									/>
									<span>
										<strong>{group}</strong>
										<small>
											{images.length} {images.length === 1 ? "screen" : "screens"}
										</small>
									</span>
								</button>
							);
						})}
					</div>
				</section>
			) : null}
			{analysis ? (
				<section
					className={styles.takeaways}
					aria-label={analysis.readout ? "Product brief" : "Product advice"}
				>
					<div className={styles.resultHeading}>
						<div className={styles.summary}>
							<h2>{analysis.readout ? "Product brief" : "Product takeaways"}</h2>
							<p
								hidden={!!analysis.readout && !summaryExpanded}
								className={summaryExpanded ? undefined : styles.summaryPreview}
							>
								{!summaryExpanded && analysis.summary.length > 250
									? `${analysis.summary.slice(0, 250).trimEnd()}…`
									: analysis.summary}
							</p>
							{
								<button
									type="button"
									className={styles.textButton}
									aria-expanded={summaryExpanded}
									onClick={() => setSummaryExpanded((expanded) => !expanded)}
								>
									{summaryExpanded ? "Less summary" : "Full summary"}
								</button>
							}
						</div>
					</div>
					{batch?.companyContext ? (
						<p className={styles.muted}>
							{batch.companyContext.status === "retrieved" ? (
								<>
									Company context grounded in{" "}
									{batch.companyContext.sourceUrls.map((url) => (
										<a key={url} href={url} target="_blank" rel="noreferrer">
											{new URL(url).hostname}
										</a>
									))}
								</>
							) : (
								"Company site wasn’t retrieved. Advice uses the screens and any written context; website fit is unverified."
							)}
						</p>
					) : null}
					{analysis.understanding && !analysis.readout ? (
						<details className={styles.understanding}>
							<summary>
								Working understanding · {analysis.understanding.confidence} confidence
							</summary>
							<dl>
								<dt>Product</dt>
								<dd>{analysis.understanding.product}</dd>
								<dt>Audience</dt>
								<dd>{analysis.understanding.audience}</dd>
								<dt>Job to be done</dt>
								<dd>{analysis.understanding.job}</dd>
							</dl>
						</details>
					) : null}
					{!analysis.readout ? journeyContent : null}
					{analysis.readout ? (
						<>
							{analysis.understanding ? (
								<div className={styles.briefUnderstanding}>
									<p>
										<strong>Product</strong>
										{analysis.understanding.product}
									</p>
									{!analysis.journey ? (
										<p>
											<strong>Job to be done</strong>
											{analysis.understanding.job}
										</p>
									) : null}
									<details className={styles.understanding}>
										<summary>Audience & confidence</summary>
										<p>
											{analysis.understanding.audience} · {analysis.understanding.confidence}{" "}
											confidence
										</p>
									</details>
								</div>
							) : null}
							{journeyContent}
							<div className={styles.readout}>
								<section aria-label="Works well">
									<h3>Works well</h3>
									{analysis.readout.strengths.length ? (
										analysis.readout.strengths.slice(0, showAllFindings ? 3 : 1).map(insightCard)
									) : (
										<p className={styles.muted}>No supported strengths in these screens.</p>
									)}
								</section>
								<section aria-label="Creates friction">
									<h3>Creates friction</h3>
									{analysis.readout.frictions.length ? (
										analysis.readout.frictions.slice(0, showAllFindings ? 3 : 1).map(insightCard)
									) : (
										<p className={styles.muted}>No supported friction in these screens.</p>
									)}
								</section>
							</div>
							{extraFindingCount ? (
								<button
									type="button"
									className={styles.textButton}
									aria-expanded={showAllFindings}
									onClick={() => setShowAllFindings((shown) => !shown)}
								>
									{showAllFindings ? "Fewer findings" : `More findings (${extraFindingCount})`}
								</button>
							) : null}
							<h3 className={styles.nextStepHeading}>Recommended next step</h3>
						</>
					) : null}
					<div className={`${styles.advice}${analysis.readout ? ` ${styles.nextStep}` : ""}`}>
						{analysis.decisions
							? analysis.decisions.slice(0, showAllDecisions ? 5 : decisionLimit).map(decisionCard)
							: !analysis.readout
								? analysis.screens.slice(0, showLegacyAdvice ? 3 : 1).map((screen) => (
										<article key={screen.imageId}>
											<button
												type="button"
												className={styles.evidenceLink}
												onClick={() => openEvidence(screen.imageId)}
											>
												{screen.label}
											</button>
											<p className={styles.advicePreview}>{screen.advice}</p>
											<button
												type="button"
												className={styles.textButton}
												onClick={() => openEvidence(screen.imageId)}
												aria-label={`Inspect ${screen.label}`}
											>
												Inspect evidence
											</button>
										</article>
									))
								: null}
					</div>
					{!analysis.readout && !analysis.decisions && analysis.screens.length > 1 ? (
						<button
							type="button"
							className={styles.textButton}
							aria-expanded={showLegacyAdvice}
							onClick={() => setShowLegacyAdvice((shown) => !shown)}
						>
							{showLegacyAdvice
								? "Fewer takeaways"
								: `More takeaways (${Math.min(3, analysis.screens.length) - 1})`}
						</button>
					) : null}
					{(analysis.readout || analysis.decisions) && !analysis.decisions?.length ? (
						<p className={styles.muted}>
							No supported product decision yet. Inspect the screens and unknowns before choosing an
							experiment.
						</p>
					) : null}
					{analysis.decisions && analysis.decisions.length > decisionLimit ? (
						<button
							type="button"
							className={styles.textButton}
							aria-expanded={showAllDecisions}
							onClick={() => setShowAllDecisions((shown) => !shown)}
						>
							{showAllDecisions
								? "Fewer decisions"
								: `More decisions (${analysis.decisions.length - decisionLimit})`}
						</button>
					) : null}
					{analysis.unknowns.length ? (
						<details className={styles.unknowns}>
							<summary>What these screens don’t establish ({analysis.unknowns.length})</summary>
							<ul>
								{analysis.unknowns.map((unknown, index) => (
									<li key={`${index}-${unknown}`}>{unknown}</li>
								))}
							</ul>
						</details>
					) : null}
				</section>
			) : null}
			{batch ? (
				<button
					type="button"
					className={styles.browseButton}
					aria-expanded={libraryOpen}
					aria-controls="screenshot-library"
					onClick={() => {
						if (!libraryOpen) {
							setQuery("");
							setGroupFilter("");
							setLibraryPage(0);
						}
						setLibraryOpen((open) => !open);
					}}
				>
					<ChevronRight size={13} aria-hidden="true" /> Browse {batch.images.length}{" "}
					{batch.images.length === 1 ? "screen" : "screens"}
				</button>
			) : null}
			{libraryOpen ? (
				<section id="screenshot-library" aria-label="Screenshot library" className={styles.library}>
					{batch && batch.images.length > 1 ? (
						<div className={styles.findScreens}>
							<label className={styles.search}>
								<Search size={14} aria-hidden="true" />
								<input
									type="search"
									aria-label="Search screenshots"
									placeholder="Find a screen or finding…"
									value={query}
									onChange={(event) => {
										setQuery(event.target.value);
										setLibraryPage(0);
									}}
								/>
							</label>
							{allGroups.length > 1 ? (
								<select
									aria-label="Screen group"
									value={groupFilter}
									onChange={(event) => {
										setGroupFilter(event.target.value);
										setLibraryPage(0);
									}}
								>
									<option value="">All groups</option>
									{allGroups.map((group) => (
										<option key={group} value={group}>
											{group}
										</option>
									))}
								</select>
							) : null}
							{query || groupFilter ? (
								<button
									type="button"
									className={styles.textButton}
									onClick={() => {
										setQuery("");
										setGroupFilter("");
										setLibraryPage(0);
									}}
								>
									Clear filters
								</button>
							) : null}
							<span className={styles.muted} aria-live="polite">
								{visibleImages.length} of {batch.images.length}
							</span>
						</div>
					) : null}
					{batch && !visibleImages.length ? (
						<p className={styles.emptyResults}>
							No screens match. Try another term or clear the filters.
						</p>
					) : null}
					<div className={styles.groups}>
						{[...pageGroups].map(([group, images]) => (
							<section key={group} aria-label={group}>
								<h3>
									{group}
									<small>{images.length}</small>
								</h3>
								<div className={styles.grid}>
									{images.map((image) => {
										const screen = analysis?.screens.find((item) => item.imageId === image.id);
										return (
											<article key={image.id} className={styles.card}>
												<button
													type="button"
													onClick={() => openEvidence(image.id)}
													aria-label={`View ${screen?.label ?? image.originalName}`}
												>
													<img
														src={toFileUrl(image.thumbnailPath ?? image.path)}
														alt={screen?.label ?? image.originalName}
														loading="lazy"
													/>
													<span>{screen?.label ?? image.originalName}</span>
													{screen?.purpose ? (
														<p className={styles.purposePreview}>{screen.purpose}</p>
													) : null}
												</button>
											</article>
										);
									})}
								</div>
							</section>
						))}
					</div>
					{pageCount > 1 ? (
						<nav className={styles.pagination} aria-label="Screenshot pages">
							<button
								type="button"
								className={styles.secondary}
								disabled={currentPage === 0}
								onClick={() => setLibraryPage(currentPage - 1)}
							>
								Previous page
							</button>
							<span aria-live="polite">
								Page {currentPage + 1} of {pageCount}
							</span>
							<button
								type="button"
								className={styles.secondary}
								disabled={currentPage + 1 >= pageCount}
								onClick={() => setLibraryPage(currentPage + 1)}
							>
								Next page
							</button>
						</nav>
					) : null}
				</section>
			) : null}
			<Dialog
				open={!!evidence}
				onOpenChange={(open) => {
					if (!open) setSelectedImage(null);
				}}
			>
				<DialogContent
					className={styles.lightbox}
					onKeyDown={(event) => {
						if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
						if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
							event.preventDefault();
							event.stopPropagation();
							navigateEvidence(event.key === "ArrowLeft" ? -1 : 1);
						}
					}}
				>
					<DialogTitle>{evidenceScreen?.label ?? evidence?.originalName}</DialogTitle>
					<DialogDescription>
						{evidenceScreen?.observation ?? "Source screenshot"}
					</DialogDescription>
					{evidence ? (
						<img
							src={toFileUrl(evidence.path)}
							alt={evidenceScreen?.label ?? evidence.originalName}
						/>
					) : null}
					<div className={styles.evidenceNavigation}>
						<button
							type="button"
							className={styles.secondary}
							aria-label="Previous screenshot"
							disabled={evidenceIndex <= 0}
							onClick={() => navigateEvidence(-1)}
						>
							<ChevronLeft size={15} /> Previous
						</button>
						<span aria-live="polite">
							{decisionEvidenceIds
								? analysis?.readout
									? "Cited evidence · "
									: "Decision evidence · "
								: ""}
							{evidenceIndex + 1} of {evidenceImages.length}
						</span>
						<button
							type="button"
							className={styles.secondary}
							aria-label="Next screenshot"
							disabled={evidenceIndex >= evidenceImages.length - 1}
							onClick={() => navigateEvidence(1)}
						>
							Next <ChevronRight size={15} />
						</button>
					</div>
					{evidence ? (
						<p className={styles.muted}>
							{evidence.originalName} · {evidence.width} × {evidence.height}
							{evidenceScreen ? ` · ${evidenceScreen.group}` : ""}
						</p>
					) : null}
					{evidenceScreen?.purpose ? (
						<p className={styles.inspectorPurpose}>
							<strong>Purpose</strong>
							{evidenceScreen.purpose}
						</p>
					) : null}
					{evidenceScreen ? (
						<div className={styles.inspectorAdvice}>
							<p>
								<strong>Hypothesis · {evidenceScreen.confidence} confidence</strong>
								{evidenceScreen.hypothesis}
							</p>
							<p>
								<strong>For our product</strong>
								{evidenceScreen.advice}
							</p>
						</div>
					) : null}
				</DialogContent>
			</Dialog>
		</section>
	);
}
