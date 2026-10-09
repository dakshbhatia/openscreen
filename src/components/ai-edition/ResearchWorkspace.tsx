import { Circle, FileVideo2, Images, Upload, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { ProductIntelPanel } from "./ProductIntelPanel";
import styles from "./ResearchWorkspace.module.css";
import { ScreenshotBoard } from "./ScreenshotBoard";

interface ResearchWorkspaceProps {
	active: boolean;
	projectId: string | null;
	projectTitle: string | null;
	freshRecordingProjectId: string | null;
	asset: AxcutAsset | null;
	sourceReady: boolean;
	importing: boolean;
	onRecord: () => void;
	onImport: () => void;
	onLoadedMetadata: (durationSec: number, assetId: string) => void;
}

const durationLabel = (seconds: number) =>
	`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function ResearchWorkspace({
	active,
	projectId,
	projectTitle,
	freshRecordingProjectId,
	asset,
	sourceReady,
	importing,
	onRecord,
	onImport,
	onLoadedMetadata,
}: ResearchWorkspaceProps) {
	const [inputMode, setInputMode] = useState<"screenshots" | "recording">("screenshots");
	const activatedRecording = useRef<string | null>(null);
	useEffect(() => {
		if (
			projectId &&
			projectId === freshRecordingProjectId &&
			activatedRecording.current !== projectId
		) {
			activatedRecording.current = projectId;
			setInputMode("recording");
		}
	}, [projectId, freshRecordingProjectId]);
	const recordingActive = active && inputMode === "recording";
	const rawVideo = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (!recordingActive) rawVideo.current?.pause();
	}, [recordingActive]);
	const [failedSource, setFailedSource] = useState<string | null>(null);
	const sourceIdentity = asset ? `${projectId}:${asset.id}:${asset.originalPath}` : null;
	const source =
		asset && sourceReady && asset.durationSec
			? { assetId: asset.id, path: asset.originalPath, durationSec: asset.durationSec }
			: null;

	return (
		<main className={styles.workspace} aria-label="Competitor research" hidden={!active}>
			<div className={styles.inner}>
				<div
					className={styles.inputTabs}
					role="tablist"
					aria-label="Analysis input"
					onKeyDown={(event) => {
						if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
						event.preventDefault();
						const buttons = Array.from(
							event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
						);
						const index = inputMode === "screenshots" ? 0 : 1;
						const target = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
						buttons[target]?.click();
						buttons[target]?.focus();
					}}
				>
					<button
						type="button"
						id="screenshots-tab"
						role="tab"
						aria-selected={inputMode === "screenshots"}
						tabIndex={inputMode === "screenshots" ? 0 : -1}
						aria-controls="screenshots-panel"
						onClick={() => setInputMode("screenshots")}
					>
						<Images size={14} aria-hidden /> Screenshots
					</button>
					<button
						type="button"
						id="recording-tab"
						role="tab"
						aria-selected={inputMode === "recording"}
						tabIndex={inputMode === "recording" ? 0 : -1}
						aria-controls="recording-panel"
						onClick={() => setInputMode("recording")}
					>
						<Video size={14} aria-hidden /> Recording
					</button>
				</div>
				<div
					id="screenshots-panel"
					role="tabpanel"
					aria-labelledby="screenshots-tab"
					hidden={inputMode !== "screenshots"}
				>
					<ScreenshotBoard active={active && inputMode === "screenshots"} />
				</div>
				<div
					id="recording-panel"
					role="tabpanel"
					aria-labelledby="recording-tab"
					hidden={inputMode !== "recording"}
					className={styles.recordingPanel}
				>
					<div className={styles.actions}>
						<button
							type="button"
							className={styles.secondaryButton}
							onClick={onRecord}
							disabled={importing}
						>
							<Circle size={12} fill="currentColor" aria-hidden /> Record flow
						</button>
						<button
							type="button"
							className={styles.secondaryButton}
							onClick={onImport}
							disabled={importing}
						>
							<Upload size={14} aria-hidden /> {importing ? "Importing…" : "Import recording"}
						</button>
					</div>

					{asset ? (
						<details className={styles.sourceCard}>
							<summary>
								<FileVideo2 size={19} className={styles.sourceIcon} aria-hidden />
								<span className={styles.sourceIdentity}>
									<strong>{asset.label || asset.originalPath.split(/[\\/]/).pop()}</strong>
									<span>{projectTitle || "Current project"} · Original recording</span>
								</span>
								<span className={styles.sourceStatus}>
									{source ? durationLabel(source.durationSec) : "Reading recording…"}
								</span>
								<span className={styles.sourceDisclosure}>View recording</span>
							</summary>
							<video
								key={sourceIdentity}
								ref={rawVideo}
								className={styles.sourceVideo}
								src={
									/^(https?|blob|data):/.test(asset.originalPath)
										? asset.originalPath
										: toFileUrl(asset.originalPath)
								}
								controls
								preload="metadata"
								aria-label="Original competitor recording"
								onLoadedMetadata={(event) => {
									setFailedSource(null);
									onLoadedMetadata(event.currentTarget.duration, asset.id);
								}}
								onError={() => setFailedSource(sourceIdentity)}
							/>
						</details>
					) : (
						<div className={styles.emptySource}>
							<FileVideo2 size={20} aria-hidden />
							<span>Start with a competitor recording to analyze its product flow.</span>
						</div>
					)}
					{sourceIdentity && failedSource === sourceIdentity ? (
						<p role="alert" className={styles.sourceError}>
							This recording could not be loaded. Import it again or open another project.
						</p>
					) : null}

					<ProductIntelPanel
						embedded
						open={recordingActive}
						onOpenChange={() => {
							// Embedded analysis stays in this workspace.
						}}
						projectId={projectId}
						freshRecordingProjectId={freshRecordingProjectId}
						source={source}
					/>
				</div>
			</div>
		</main>
	);
}
