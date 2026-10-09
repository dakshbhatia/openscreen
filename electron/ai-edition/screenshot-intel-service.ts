import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { type CompanyContext, parseCompanyContext } from "../../src/lib/company-context";
import { type IntelSettings, intelSettingsSchema } from "../../src/lib/product-intel";
import { PRODUCT_REASONING_RULES } from "../../src/lib/product-reasoning";
import {
	buildScreenshotPrompt,
	MAX_SCREENSHOT_BATCH_BYTES,
	MAX_SCREENSHOT_BYTES,
	MAX_SCREENSHOT_IMAGES,
	MAX_SCREENSHOT_REQUEST_IMAGES,
	parseScreenshotAnalysis,
	SCREENSHOT_ANALYST_PROMPT,
	SCREENSHOT_SYNTHESIS_PROMPT,
	type ScreenshotAnalysis,
	type ScreenshotBatch,
	type ScreenshotImage,
	screenshotAnalysisSchema,
	screenshotBatchIdSchema,
	screenshotBatchSchema,
	screenshotDecisionSchema,
	screenshotImageIdSchema,
	screenshotImageSchema,
	screenshotJourneySchema,
	screenshotReadoutInsightSchema,
	screenshotReadoutSchema,
	screenshotUnderstandingSchema,
} from "../../src/lib/screenshot-intel";

import { geminiHttpError } from "./gemini-errors";

const API = "https://generativelanguage.googleapis.com";
// New responses require collection decisions. Keep array limits in local validation,
// outside Google's grammar; old saved analyses may still omit decisions.
const currentAnalysisSchema = screenshotAnalysisSchema.extend({
	decisions: z.array(screenshotDecisionSchema).max(5),
	understanding: screenshotUnderstandingSchema,
	screens: z
		.array(screenshotAnalysisSchema.shape.screens.element.required({ purpose: true }))
		.min(1)
		.max(MAX_SCREENSHOT_IMAGES),
	readout: screenshotReadoutSchema,
	journey: screenshotJourneySchema,
});
const geminiReadoutInsightSchema = screenshotReadoutInsightSchema.extend({
	evidenceImageIds: z.array(screenshotImageIdSchema),
});
const geminiAnalysisSchema = currentAnalysisSchema.extend({
	screens: z.array(currentAnalysisSchema.shape.screens.element),
	unknowns: z.array(screenshotAnalysisSchema.shape.unknowns.element),
	decisions: z.array(
		screenshotDecisionSchema.extend({ evidenceImageIds: z.array(screenshotImageIdSchema) }),
	),
	readout: z.strictObject({
		strengths: z.array(geminiReadoutInsightSchema),
		frictions: z.array(geminiReadoutInsightSchema),
	}),
	journey: screenshotJourneySchema.extend({
		stages: z.array(
			screenshotJourneySchema.shape.stages.element.extend({
				evidenceImageIds: z.array(screenshotImageIdSchema),
			}),
		),
	}),
});
const screenGroupSchema = z.strictObject({
	name: screenshotAnalysisSchema.shape.screens.element.shape.group,
	imageIds: z.array(screenshotImageIdSchema).min(1).max(MAX_SCREENSHOT_IMAGES),
});
const currentSynthesisSchema = currentAnalysisSchema.omit({ screens: true }).extend({
	screenGroups: z.array(screenGroupSchema).min(1).max(MAX_SCREENSHOT_IMAGES),
});
const geminiSynthesisSchema = geminiAnalysisSchema.omit({ screens: true }).extend({
	screenGroups: z.array(screenGroupSchema.extend({ imageIds: z.array(screenshotImageIdSchema) })),
});
type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type ChunkAnalysis = { analysis: ScreenshotAnalysis; companyContext?: CompanyContext };

const MAX_INLINE_BYTES = 12 * 1024 * 1024;
// Up to 120 bounded per-screen records, including UTF-8 text and batch metadata.
const MAX_BATCH_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SYNTHESIS_BYTES = 8 * 1024 * 1024;
const imageOptions = { limitInputPixels: 40_000_000, animated: false, failOn: "warning" as const };
const formats = {
	png: { mimeType: "image/png", extension: "png" },
	jpeg: { mimeType: "image/jpeg", extension: "jpg" },
	webp: { mimeType: "image/webp", extension: "webp" },
} as const;
const extensionFor = (image: ScreenshotImage) =>
	image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1];
const replySchema = z.object({
	candidates: z
		.array(
			z.object({
				content: z
					.object({
						parts: z.array(
							z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
						),
					})
					.optional(),
				urlContextMetadata: z.unknown().optional(),
			}),
		)
		.optional(),
});

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function safeName(value: string): string {
	return (
		value
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-zA-Z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60)
			.toLowerCase() || "screen"
	);
}

/** Copies source images into app-owned storage; never renames or deletes originals. */
export class ScreenshotIntelService {
	private readonly root: string;
	private readonly jobs = new Map<string, AbortController>();

	constructor(
		userData: string,
		private readonly getSettings: () => Promise<IntelSettings>,
		private readonly apiKey: () => string | null,
		private readonly fetcher: typeof fetch = fetch,
	) {
		this.root = path.resolve(userData, "screenshot-intel");
	}

	private batchPath(id: string): string {
		screenshotBatchIdSchema.parse(id);
		return path.join(this.root, id);
	}

	private async write(batch: ScreenshotBatch, signal?: AbortSignal): Promise<void> {
		const parsed = screenshotBatchSchema.parse(batch);
		const directory = this.batchPath(parsed.id);
		const encoded = JSON.stringify(parsed, null, 2);
		if (Buffer.byteLength(encoded) > MAX_BATCH_JSON_BYTES)
			throw new Error("Screenshot report is too large to save.");
		const temporary = path.join(directory, `batch.${randomUUID()}.tmp`);
		try {
			await fs.writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
			signal?.throwIfAborted();
			await fs.rename(temporary, path.join(directory, "batch.json"));
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}

	async import(paths: string[]): Promise<ScreenshotBatch> {
		if (
			!Array.isArray(paths) ||
			paths.length === 0 ||
			paths.length > MAX_SCREENSHOT_IMAGES ||
			paths.some((file) => typeof file !== "string" || !path.isAbsolute(file))
		) {
			throw new Error(`Choose 1 to ${MAX_SCREENSHOT_IMAGES} PNG, JPEG or WebP screenshots.`);
		}
		if (new Set(paths).size !== paths.length) throw new Error("Choose each screenshot only once.");
		let totalBytes = 0;
		for (const file of paths) {
			const stat = await fs.stat(file);
			if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCREENSHOT_BYTES) {
				throw new Error("Each screenshot must be a non-empty image no larger than 8 MiB.");
			}
			totalBytes += stat.size;
			if (totalBytes > MAX_SCREENSHOT_BATCH_BYTES)
				throw new Error("Choose screenshots totaling no more than 192 MiB.");
		}
		const id = `batch_${randomUUID()}`;
		const directory = this.batchPath(id);
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		await fs.mkdir(directory, { mode: 0o700 });
		try {
			await fs.mkdir(path.join(directory, "images"), { mode: 0o700 });
			await fs.mkdir(path.join(directory, "thumbnails"), { mode: 0o700 });
			const images: ScreenshotImage[] = [];
			const seenPaths = new Map<string, string[]>();
			let duplicatesSkipped = 0;
			totalBytes = 0;
			for (const file of paths) {
				const bytes = await fs.readFile(file);
				totalBytes += bytes.byteLength;
				if (
					!bytes.byteLength ||
					bytes.byteLength > MAX_SCREENSHOT_BYTES ||
					totalBytes > MAX_SCREENSHOT_BATCH_BYTES
				) {
					throw new Error(
						"Screenshots changed during import or exceed the 8 MiB image / 192 MiB batch limit.",
					);
				}
				const digest = createHash("sha256").update(bytes).digest("hex");
				const matchingHash = seenPaths.get(digest);
				let duplicate = false;
				for (const previous of matchingHash ?? []) {
					if (bytes.equals(await fs.readFile(previous))) {
						duplicate = true;
						break;
					}
				}
				if (duplicate) {
					duplicatesSkipped++;
					continue;
				}

				let metadata: Metadata;
				let thumbnail: Buffer;
				try {
					metadata = await sharp(bytes, imageOptions).metadata();
					if (
						!metadata.format ||
						!(metadata.format in formats) ||
						!metadata.width ||
						!metadata.height ||
						(metadata.pages ?? 1) > 1
					) {
						throw new Error("Unsupported image");
					}
					// Decode while producing the preview; metadata alone may accept corrupt images.
					thumbnail = await sharp(bytes, imageOptions)
						.rotate()
						.resize(480, 480, { fit: "inside", withoutEnlargement: true })
						.webp({ quality: 75 })
						.toBuffer();
				} catch {
					throw new Error(
						"Choose valid, non-animated PNG, JPEG or WebP screenshots (up to 40 megapixels).",
					);
				}
				const format = formats[metadata.format as keyof typeof formats];
				const imageId = `image_${randomUUID()}`;
				const managedPath = path.join(directory, "images", `${imageId}.${format.extension}`);
				const thumbnailPath = path.join(directory, "thumbnails", `${imageId}.webp`);
				await fs.writeFile(managedPath, bytes, { mode: 0o600, flag: "wx" });
				await fs.writeFile(thumbnailPath, thumbnail, { mode: 0o600, flag: "wx" });
				seenPaths.set(digest, [...(matchingHash ?? []), managedPath]);
				images.push(
					screenshotImageSchema.parse({
						id: imageId,
						originalName: path.basename(file),
						path: managedPath,
						thumbnailPath,
						mimeType: format.mimeType,
						width: metadata.width,
						height: metadata.height,
					}),
				);
			}
			const batch: ScreenshotBatch = {
				id,
				title:
					images.length === 1
						? path.parse(images[0].originalName).name || "Screenshot"
						: `${images.length} screenshots`,
				createdAt: new Date().toISOString(),
				images,
				analysis: null,
				...(duplicatesSkipped ? { duplicatesSkipped } : {}),
			};
			await this.write(batch);
			return batch;
		} catch (error) {
			await fs.rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	async get(id: string): Promise<ScreenshotBatch> {
		const directory = this.batchPath(id);
		const file = path.join(directory, "batch.json");
		try {
			const stat = await fs.stat(file);
			if (!stat.isFile() || stat.size > MAX_BATCH_JSON_BYTES)
				throw new Error("Invalid screenshot batch metadata.");
			const batch = screenshotBatchSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
			if (
				batch.id !== id ||
				batch.images.some(
					(image) =>
						image.path !== path.join(directory, "images", `${image.id}.${extensionFor(image)}`) ||
						(image.thumbnailPath !== undefined &&
							image.thumbnailPath !== path.join(directory, "thumbnails", `${image.id}.webp`)),
				) ||
				(batch.organizedPath && batch.organizedPath !== path.join(directory, "organized"))
			) {
				throw new Error("Invalid screenshot batch paths.");
			}
			return batch;
		} catch (error) {
			if (hasCode(error, "ENOENT")) throw new Error("Screenshot batch was not found.");
			throw new Error("Saved screenshot batch could not be read.");
		}
	}

	async list(): Promise<ScreenshotBatch[]> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(this.root, { withFileTypes: true });
		} catch (error) {
			if (hasCode(error, "ENOENT")) return [];
			throw error;
		}
		const batches: ScreenshotBatch[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !screenshotBatchIdSchema.safeParse(entry.name).success) continue;
			try {
				batches.push(await this.get(entry.name));
			} catch {
				/* Keep valid batches usable if an interrupted import or metadata is unreadable. */
			}
		}
		return batches.sort(
			(a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		);
	}

	cancel(id: string): void {
		this.batchPath(id);
		this.jobs.get(id)?.abort();
	}

	private async generate(
		settings: IntelSettings,
		key: string,
		signal: AbortSignal,
		parts: GeminiPart[],
		wireSchema: z.ZodType,
		synthesis = false,
	): Promise<{ output: unknown; companyContext?: CompanyContext }> {
		signal.throwIfAborted();
		const { $schema: _schema, ...responseJsonSchema } = z.toJSONSchema(wireSchema);
		const response = await this.fetcher(`${API}/v1beta/models/${settings.model}:generateContent`, {
			method: "POST",
			signal,
			headers: { "content-type": "application/json", "x-goog-api-key": key },
			body: JSON.stringify({
				systemInstruction: {
					parts: [
						{
							text: `${settings.systemPrompt}\n\n${SCREENSHOT_ANALYST_PROMPT}\n\n${PRODUCT_REASONING_RULES}${synthesis ? `\n\n${SCREENSHOT_SYNTHESIS_PROMPT}` : ""}`,
						},
					],
				},
				contents: [{ role: "user", parts }],
				...(settings.companyDomain ? { tools: [{ urlContext: {} }] } : {}),
				generationConfig: {
					responseMimeType: "application/json",
					responseJsonSchema,
					maxOutputTokens: 16000,
				},
			}),
		});
		if (!response.ok) throw geminiHttpError(response.status, "screenshots");
		const reply = replySchema.parse(await response.json());
		const candidate = reply.candidates?.[0];
		const text = candidate?.content?.parts
			.filter((part) => !part.thought)
			.map((part) => part.text ?? "")
			.join("");
		if (!text)
			throw new Error("Gemini returned no screenshot analysis. Try again or choose another model.");
		signal.throwIfAborted();
		let output: unknown;
		try {
			output = JSON.parse(text);
		} catch {
			throw new Error("Gemini returned incomplete screenshot analysis. Try again.");
		}
		return {
			output,
			...(settings.companyDomain
				? {
						companyContext: parseCompanyContext(
							settings.companyDomain,
							candidate?.urlContextMetadata,
						),
					}
				: {}),
		};
	}

	async analyze(id: string): Promise<ScreenshotBatch> {
		this.batchPath(id);
		if (this.jobs.has(id))
			throw new Error("This screenshot batch is already being analyzed or organized.");
		const controller = new AbortController();
		this.jobs.set(id, controller);
		const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
		try {
			const key = this.apiKey();
			if (!key) throw new Error("Add a Gemini API key to analyze screenshots.");
			const batch = await this.get(id);
			const settings = intelSettingsSchema.parse(await this.getSettings());
			let totalSourceBytes = 0;
			for (const image of batch.images) {
				controller.signal.throwIfAborted();
				const stat = await fs.stat(image.path);
				totalSourceBytes += stat.size;
				if (
					!stat.isFile() ||
					!stat.size ||
					stat.size > MAX_SCREENSHOT_BYTES ||
					totalSourceBytes > MAX_SCREENSHOT_BATCH_BYTES
				) {
					throw new Error("Managed screenshots exceed the 8 MiB image / 192 MiB batch limit.");
				}
			}
			const chunks: ChunkAnalysis[] = [];
			let chunkImages: ScreenshotImage[] = [];
			let imageParts: GeminiPart[] = [];
			let inlineBytes = 0;
			const readChunk = async () => {
				if (!chunkImages.length) return;
				const chunkNote =
					chunkImages.length < batch.images.length
						? `\nThese images are processing chunk ${chunks.length + 1} of one unordered collection containing ${batch.images.length} screenshots. Describe and cite only the images supplied in this request. Chunk order is not product chronology; preserve distinct visible products and state uncertainty.`
						: "";
				const generated = await this.generate(
					settings,
					key,
					controller.signal,
					[{ text: `${buildScreenshotPrompt(settings, chunkImages)}${chunkNote}` }, ...imageParts],
					geminiAnalysisSchema,
				);
				chunks.push({
					analysis: parseScreenshotAnalysis(
						currentAnalysisSchema.parse(generated.output),
						chunkImages,
					),
					...(generated.companyContext ? { companyContext: generated.companyContext } : {}),
				});
				chunkImages = [];
				imageParts = [];
				inlineBytes = 0;
			};
			for (const image of batch.images) {
				controller.signal.throwIfAborted();
				const resized = await sharp(image.path, imageOptions)
					.rotate()
					.resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
					.webp({ quality: 90 })
					.toBuffer();
				if (resized.byteLength > MAX_INLINE_BYTES)
					throw new Error("A resized screenshot is too large for Gemini. Choose a smaller image.");
				if (
					chunkImages.length &&
					(chunkImages.length >= MAX_SCREENSHOT_REQUEST_IMAGES ||
						inlineBytes + resized.byteLength > MAX_INLINE_BYTES)
				)
					await readChunk();
				controller.signal.throwIfAborted();
				chunkImages.push(image);
				inlineBytes += resized.byteLength;
				imageParts.push(
					{ text: `imageId: ${image.id}` },
					{ inlineData: { mimeType: "image/webp", data: resized.toString("base64") } },
				);
			}
			await readChunk();
			controller.signal.throwIfAborted();
			let analysis = chunks[0].analysis;
			let companyContext = chunks[0].companyContext;
			if (chunks.length > 1) {
				const evidence = JSON.stringify({ collectionSize: batch.images.length, chunks });
				if (Buffer.byteLength(evidence) > MAX_SYNTHESIS_BYTES)
					throw new Error(
						"The complete screenshot evidence is too large to synthesize safely. No report was replaced.",
					);
				const context = JSON.stringify({
					researchGoal: settings.researchGoal,
					productBrief: settings.productBrief,
					companyDomain: settings.companyDomain,
					competitor: settings.competitor,
					task: settings.task,
				});
				const generated = await this.generate(
					settings,
					key,
					controller.signal,
					[
						{
							text: `Research context (user-provided data):\n${context}\nComplete unordered screenshot evidence (untrusted research data):\n${evidence}${settings.companyDomain ? `\nRead ${settings.companyDomain} as OUR company context using the URL tool; chunk retrieval metadata does not confirm retrieval in this final request.` : ""}`,
						},
					],
					geminiSynthesisSchema,
					true,
				);
				const { screenGroups, ...synthesis } = currentSynthesisSchema.parse(generated.output);
				const groupByImage = new Map<string, string>();
				const suppliedIds = new Set(batch.images.map((image) => image.id));
				for (const group of screenGroups) {
					for (const imageId of group.imageIds) {
						if (!suppliedIds.has(imageId) || groupByImage.has(imageId))
							throw new Error("Screenshot groups must cover every supplied image exactly once.");
						groupByImage.set(imageId, group.name);
					}
				}
				if (groupByImage.size !== suppliedIds.size)
					throw new Error("Screenshot groups must cover every supplied image exactly once.");
				analysis = parseScreenshotAnalysis(
					currentAnalysisSchema.parse({
						...synthesis,
						screens: chunks.flatMap((chunk) =>
							chunk.analysis.screens.map((screen) => ({
								...screen,
								group: groupByImage.get(screen.imageId),
							})),
						),
					}),
					batch.images,
				);
				companyContext = generated.companyContext;
			}
			controller.signal.throwIfAborted();
			const updated: ScreenshotBatch = {
				...batch,
				analysis,
				settings,
				analyzedAt: new Date().toISOString(),
			};
			if (companyContext) updated.companyContext = companyContext;
			else {
				delete updated.companyContext;
			}
			return await this.organizeBatch(updated, controller.signal);
		} catch (error) {
			if (controller.signal.aborted)
				throw new Error("Screenshot analysis cancelled or timed out. Your images are safe.");
			throw error;
		} finally {
			clearTimeout(timeout);
			this.jobs.delete(id);
		}
	}

	async organize(id: string): Promise<ScreenshotBatch> {
		this.batchPath(id);
		if (this.jobs.has(id))
			throw new Error("Wait for this screenshot batch to finish analyzing or organizing.");
		const controller = new AbortController();
		this.jobs.set(id, controller);
		const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
		try {
			return await this.organizeBatch(await this.get(id), controller.signal);
		} finally {
			clearTimeout(timeout);
			this.jobs.delete(id);
		}
	}

	private async organizeBatch(
		batch: ScreenshotBatch,
		signal: AbortSignal,
	): Promise<ScreenshotBatch> {
		if (!batch.analysis) throw new Error("Analyze screenshots before organizing them.");
		const directory = this.batchPath(batch.id);
		const organizedPath = path.join(directory, "organized");
		const staging = path.join(directory, `organized-${randomUUID()}.tmp`);
		const backup = path.join(directory, `organized-backup-${randomUUID()}.tmp`);
		let backedUp = false;
		let installed = false;
		await fs.mkdir(staging, { mode: 0o700 });
		try {
			let totalBytes = 0;
			for (const screen of batch.analysis.screens) {
				signal.throwIfAborted();
				const image = batch.images.find((item) => item.id === screen.imageId);
				if (!image) throw new Error("Screenshot analysis contains an unknown image.");
				const stat = await fs.stat(image.path);
				totalBytes += stat.size;
				if (
					!stat.isFile() ||
					!stat.size ||
					stat.size > MAX_SCREENSHOT_BYTES ||
					totalBytes > MAX_SCREENSHOT_BATCH_BYTES
				) {
					throw new Error("Managed screenshots exceed the 8 MiB image / 192 MiB batch limit.");
				}
				const groupHash = createHash("sha256").update(screen.group).digest("hex").slice(0, 8);
				const groupPath = path.join(staging, `${safeName(screen.group)}-${groupHash}`);
				await fs.mkdir(groupPath, { recursive: true, mode: 0o700 });
				await fs.copyFile(
					image.path,
					path.join(groupPath, `${safeName(screen.label)}-${image.id}.${extensionFor(image)}`),
					constants.COPYFILE_EXCL,
				);
			}
			signal.throwIfAborted();
			try {
				await fs.rename(organizedPath, backup);
				backedUp = true;
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error;
			}
			await fs.rename(staging, organizedPath);
			installed = true;
			signal.throwIfAborted();
			const organized = { ...batch, organizedPath };
			await this.write(organized, signal);
			if (backedUp)
				await fs.rm(backup, { recursive: true, force: true }).catch(() => {
					// The new manifest and folder are committed; keep a failed backup cleanup recoverable.
				});
			return organized;
		} catch (error) {
			if (installed) await fs.rm(organizedPath, { recursive: true, force: true });
			if (backedUp) await fs.rename(backup, organizedPath);
			throw error;
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	}
}
