import { Check, FolderOpen, Images, LoaderCircle, Sparkles, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { DEFAULT_INTEL_SETTINGS, type IntelSettings } from "@/lib/product-intel";
import type { ScreenshotBatch } from "@/lib/screenshot-intel";
import { nativeBridgeClient } from "@/native/client";
import styles from "./ScreenshotBoard.module.css";

interface Props {
	active: boolean;
}
type Screen = NonNullable<ScreenshotBatch["analysis"]>["screens"][number];
const message = (error: unknown) =>
	shareText(error instanceof Error ? error.message : "Could not complete this request. Retry.");

function shareText(value: string): string {
	return value
		.replace(/AIza[\w-]{35}/g, "[redacted]")
		.replace(/file:\/\/[^\s<>"`]+/gi, "[redacted]")
		.replace(/(?:[A-Za-z]:\\|\\\\)[^\s<>"`]+/g, "[redacted]")
		.replace(/(?<![\w:/])\/(?:Users|home|private|Volumes|tmp)\/[^\s<>"`]+/g, "[redacted]");
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
					competitor: shareText(batch.settings.competitor),
					task: shareText(batch.settings.task),
					model: batch.settings.model,
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
					screens: batch.analysis.screens.map((screen) => ({
						imageId: screen.imageId,
						label: shareText(screen.label),
						group: shareText(screen.group),
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
	const [dragging, setDragging] = useState(false);
	const [selectedImage, setSelectedImage] = useState<string | null>(null);
	const working = useRef(false);
	const more = useRef<HTMLDetailsElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const settingsDirty = useRef(false);
	const settingsVersion = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt retries unavailable setup.
	useEffect(() => {
		if (!active || working.current) return;
		let stale = false;
		setError("");
		setLoaded(false);
		void Promise.all([
			nativeBridgeClient.productIntel.snapshot(),
			nativeBridgeClient.screenshotIntel.list(),
		])
			.then(([snapshot, batches]) => {
				if (stale) return;
				if (!settingsDirty.current) setSettings(snapshot.settings);
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
		setSettings((previous) => ({ ...previous, [field]: value }));
	}
	function remember(next: ScreenshotBatch) {
		setBatch(next);
		setSelectedImage(null);
		setRecent((previous) => [next, ...previous.filter((item) => item.id !== next.id)]);
	}
	async function saveContext() {
		if (!settingsDirty.current || !loaded || busy) return;
		const version = settingsVersion.current;
		try {
			await nativeBridgeClient.productIntel.saveSettings(settings);
			if (version === settingsVersion.current) settingsDirty.current = false;
		} catch (err) {
			setError(message(err));
		}
	}
	async function run(
		kind: "import" | "analyze" | "organize",
		action: () => Promise<ScreenshotBatch | null>,
	) {
		if (working.current) return;
		working.current = true;
		setBusy(kind);
		setError("");
		try {
			const result = await action();
			if (result) remember(result);
		} catch (err) {
			setError(message(err));
		} finally {
			working.current = false;
			setBusy(null);
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
			await nativeBridgeClient.productIntel.saveSettings(settings);
			settingsDirty.current = false;
			return nativeBridgeClient.screenshotIntel.analyze(batch.id);
		});
	}
	function download(format: "markdown" | "json") {
		if (!batch) return;
		const shared = shareableBatch(batch);
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
									`Competitor: ${shared.context.competitor}`,
									`Research question: ${shared.context.task}`,
								]
							: []),
						...(shared.analysis?.screens.flatMap((screen) => [
							`## ${screen.group} / ${screen.label}`,
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
	const contextChanged =
		batch?.settings &&
		(batch.settings.productBrief !== settings.productBrief ||
			batch.settings.competitor !== settings.competitor ||
			batch.settings.task !== settings.task ||
			batch.settings.model !== settings.model ||
			batch.settings.systemPrompt !== settings.systemPrompt);
	const groups = new Map<string, ScreenshotBatch["images"]>();
	for (const image of batch?.images ?? []) {
		const group =
			analysis?.screens.find((screen) => screen.imageId === image.id)?.group ?? "Screenshots";
		groups.set(group, [...(groups.get(group) ?? []), image]);
	}
	const evidence = batch?.images.find((image) => image.id === selectedImage);
	const evidenceScreen = analysis?.screens.find((screen) => screen.imageId === selectedImage);
	const details = (screen: Screen) => (
		<details className={styles.evidenceDetails}>
			<summary>Details</summary>
			<p>
				<strong>Observed</strong>
				{screen.observation}
			</p>
			<p>
				<strong>Hypothesis · {screen.confidence} confidence</strong>
				{screen.hypothesis}
			</p>
		</details>
	);

	return (
		<section
			className={styles.board}
			aria-label="Screenshot research"
			hidden={!active}
			onDragOver={(event) => {
				event.preventDefault();
				if (!busy) setDragging(true);
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
				if (busy || !loaded) return;
				const paths = Array.from(event.dataTransfer.files).map(
					(file) => window.electronAPI?.getPathForFile(file) ?? "",
				);
				if (!paths.length || paths.some((path) => !path)) {
					setError("Could not read these files. Use Add screenshots to choose them.");
					return;
				}
				void run("import", () => nativeBridgeClient.screenshotIntel.import(paths));
			}}
		>
			<div className={`${styles.import} ${dragging ? styles.dragging : ""}`}>
				<Images size={20} />
				<span>{batch ? `${batch.images.length} screenshots` : "Drop screenshots here"}</span>
				<button
					type="button"
					className={styles.secondary}
					disabled={!loaded || !!busy}
					onClick={() => void run("import", () => nativeBridgeClient.screenshotIntel.pick())}
				>
					<Upload size={14} /> Add screenshots
				</button>
				<details className={styles.more} ref={more}>
					<summary>More</summary>
					<div className={styles.menu}>
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
									disabled={!loaded || !!busy}
									onChange={(event) => setKey(event.target.value)}
								/>
							</label>
							<button
								type="button"
								className={styles.secondary}
								disabled={!loaded || !key.trim() || !!busy}
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
								disabled={!!busy || !recent.length}
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
										{item.title}
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
									disabled={!loaded || !!busy}
									onChange={(event) => update("competitor", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<label>
								Research question
								<input
									value={settings.task}
									disabled={!loaded || !!busy}
									onChange={(event) => update("task", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<label>
								Model
								<input
									value={settings.model}
									disabled={!loaded || !!busy}
									onChange={(event) => update("model", event.target.value)}
									onBlur={() => void saveContext()}
								/>
							</label>
							<label>
								System prompt
								<textarea
									rows={5}
									value={settings.systemPrompt}
									disabled={!loaded || !!busy}
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
								disabled={!!busy}
								onClick={() =>
									void run("organize", () => nativeBridgeClient.screenshotIntel.organize(batch.id))
								}
							>
								Organize copies
							</button>
						) : null}
						{analysis?.unknowns.length ? (
							<details>
								<summary>Unknowns ({analysis.unknowns.length})</summary>
								<ul>
									{analysis.unknowns.map((unknown, index) => (
										<li key={`${index}-${unknown}`}>{unknown}</li>
									))}
								</ul>
							</details>
						) : null}
					</div>
				</details>
			</div>
			<div className={styles.context}>
				<label>
					Our product
					<textarea
						aria-label="Our product"
						rows={2}
						placeholder="Audience, goal, and what makes our approach different"
						value={settings.productBrief}
						disabled={!loaded || !!busy}
						onChange={(event) => update("productBrief", event.target.value)}
						onBlur={() => void saveContext()}
					/>
				</label>
				<div className={styles.analyze}>
					<button
						type="button"
						className={styles.primary}
						disabled={!loaded || !batch?.images.length || !!busy}
						onClick={analyze}
					>
						{busy === "analyze" ? (
							<LoaderCircle size={15} className={styles.spin} />
						) : (
							<Sparkles size={15} />
						)}
						{busy === "analyze" ? "Analyzing screenshots…" : "Analyze screenshots"}
					</button>
				</div>
			</div>
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
					{busy === "analyze"
						? "Analyzing images and organizing copies…"
						: busy === "import"
							? "Importing screenshots…"
							: busy === "organize"
								? "Organizing copies…"
								: "Organizing copies…"}
					{busy === "analyze" && batch ? (
						<button
							type="button"
							onClick={() =>
								void nativeBridgeClient.screenshotIntel
									.cancel(batch.id)
									.catch((err) => setError(message(err)))
							}
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
			{analysis ? (
				<section className={styles.takeaways} aria-label="Product advice">
					<div className={styles.resultHeading}>
						<p>{analysis.summary}</p>
						{batch?.organizedPath ? (
							<button
								type="button"
								className={styles.secondary}
								onClick={() =>
									void nativeBridgeClient.screenshotIntel
										.reveal(batch.id)
										.catch((err) => setError(message(err)))
								}
							>
								<FolderOpen size={14} /> Open organized folder
							</button>
						) : null}
					</div>
					<div className={styles.advice}>
						{analysis.screens.slice(0, 3).map((screen) => (
							<article key={screen.imageId}>
								<button
									type="button"
									className={styles.evidenceLink}
									onClick={() => setSelectedImage(screen.imageId)}
								>
									{screen.label}
								</button>
								<p>{screen.advice}</p>
								{details(screen)}
							</article>
						))}
					</div>
				</section>
			) : null}
			<div className={styles.groups}>
				{[...groups].map(([group, images]) => (
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
											onClick={() => setSelectedImage(image.id)}
											aria-label={`View ${screen?.label ?? image.originalName}`}
										>
											<img
												src={toFileUrl(image.path)}
												alt={screen?.label ?? image.originalName}
												loading="lazy"
											/>
											<span>{screen?.label ?? image.originalName}</span>
										</button>
										<details className={styles.evidenceDetails}>
											<summary>Details</summary>
											<p className={styles.muted}>{image.originalName}</p>
											{screen ? (
												<>
													<p>
														<strong>Observed</strong>
														{screen.observation}
													</p>
													<p>
														<strong>Hypothesis · {screen.confidence} confidence</strong>
														{screen.hypothesis}
													</p>
													<p>
														<strong>For our product</strong>
														{screen.advice}
													</p>
												</>
											) : null}
										</details>
									</article>
								);
							})}
						</div>
					</section>
				))}
			</div>
			<Dialog
				open={!!evidence}
				onOpenChange={(open) => {
					if (!open) setSelectedImage(null);
				}}
			>
				<DialogContent className={styles.lightbox}>
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
					{evidenceScreen ? <p className={styles.muted}>{evidenceScreen.advice}</p> : null}
				</DialogContent>
			</Dialog>
		</section>
	);
}
