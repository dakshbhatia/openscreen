import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { parseCompanyContext } from "../../src/lib/company-context";
import { type IntelSettings, intelSettingsSchema } from "../../src/lib/product-intel";
import { PRODUCT_REASONING_RULES } from "../../src/lib/product-reasoning";
import {
	buildScreenshotPrompt,
	MAX_SCREENSHOT_BATCH_BYTES,
	MAX_SCREENSHOT_BYTES,
	MAX_SCREENSHOT_IMAGES,
	parseScreenshotAnalysis,
	SCREENSHOT_ANALYST_PROMPT,
	type ScreenshotBatch,
	type ScreenshotImage,
	screenshotAnalysisSchema,
	screenshotBatchIdSchema,
	screenshotBatchSchema,
	screenshotDecisionSchema,
	screenshotImageIdSchema,
	screenshotImageSchema,
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
});

const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const MAX_BATCH_JSON_BYTES = 512 * 1024;
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
				throw new Error("Each screenshot must be a non-empty image no larger than 8 MB.");
			}
			totalBytes += stat.size;
			if (totalBytes > MAX_SCREENSHOT_BATCH_BYTES)
				throw new Error("Choose screenshots totaling no more than 24 MB.");
		}
		const id = `batch_${randomUUID()}`;
		const directory = this.batchPath(id);
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		await fs.mkdir(directory, { mode: 0o700 });
		try {
			await fs.mkdir(path.join(directory, "images"), { mode: 0o700 });
			const images: ScreenshotImage[] = [];
			const seenBytes = new Map<string, Buffer[]>();
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
						"Screenshots changed during import or exceed the 8 MB image / 24 MB batch limit.",
					);
				}
				const digest = createHash("sha256").update(bytes).digest("hex");
				const matchingHash = seenBytes.get(digest);
				if (matchingHash?.some((previous) => previous.equals(bytes))) {
					duplicatesSkipped++;
					continue;
				}

				let metadata: Metadata;
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
					// Force a decode; metadata alone can accept a truncated or corrupt image.
					await sharp(bytes, imageOptions).resize(1, 1).png().toBuffer();
				} catch {
					throw new Error(
						"Choose valid, non-animated PNG, JPEG or WebP screenshots (up to 40 megapixels).",
					);
				}
				const format = formats[metadata.format as keyof typeof formats];
				const imageId = `image_${randomUUID()}`;
				const managedPath = path.join(directory, "images", `${imageId}.${format.extension}`);
				await fs.writeFile(managedPath, bytes, { mode: 0o600, flag: "wx" });
				seenBytes.set(digest, [...(matchingHash ?? []), bytes]);
				images.push(
					screenshotImageSchema.parse({
						id: imageId,
						originalName: path.basename(file),
						path: managedPath,
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
						image.path !== path.join(directory, "images", `${image.id}.${extensionFor(image)}`),
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
			const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
				{ text: buildScreenshotPrompt(settings, batch.images) },
			];
			let inlineBytes = 0;
			for (const image of batch.images) {
				controller.signal.throwIfAborted();
				const stat = await fs.stat(image.path);
				if (!stat.isFile() || !stat.size || stat.size > MAX_SCREENSHOT_BYTES)
					throw new Error("A managed screenshot is missing or exceeds the 8 MB limit.");
				const resized = await sharp(image.path, imageOptions)
					.rotate()
					.resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
					.webp({ quality: 90 })
					.toBuffer();
				inlineBytes += resized.byteLength;
				if (inlineBytes > MAX_INLINE_BYTES)
					throw new Error("The image request is too large. Try fewer or smaller screenshots.");
				parts.push(
					{ text: `imageId: ${image.id}` },
					{ inlineData: { mimeType: "image/webp", data: resized.toString("base64") } },
				);
			}
			controller.signal.throwIfAborted();
			const { $schema: _schema, ...responseJsonSchema } = z.toJSONSchema(geminiAnalysisSchema);
			const response = await this.fetcher(
				`${API}/v1beta/models/${settings.model}:generateContent`,
				{
					method: "POST",
					signal: controller.signal,
					headers: { "content-type": "application/json", "x-goog-api-key": key },
					body: JSON.stringify({
						systemInstruction: {
							parts: [
								{
									text: `${settings.systemPrompt}\n\n${SCREENSHOT_ANALYST_PROMPT}\n\n${PRODUCT_REASONING_RULES}`,
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
				},
			);
			if (!response.ok) throw geminiHttpError(response.status, "screenshots");
			const reply = replySchema.parse(await response.json());
			const candidate = reply.candidates?.[0];
			const output = candidate?.content?.parts
				.filter((part) => !part.thought)
				.map((part) => part.text ?? "")
				.join("");
			if (!output)
				throw new Error(
					"Gemini returned no screenshot analysis. Try fewer screenshots or another model.",
				);
			const analysis = parseScreenshotAnalysis(
				currentAnalysisSchema.parse(JSON.parse(output)),
				batch.images,
			);
			controller.signal.throwIfAborted();
			const updated: ScreenshotBatch = {
				...batch,
				analysis,
				settings,
				analyzedAt: new Date().toISOString(),
			};
			if (settings.companyDomain) {
				updated.companyContext = parseCompanyContext(
					settings.companyDomain,
					candidate?.urlContextMetadata,
				);
			} else {
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
					throw new Error("Managed screenshots exceed the 8 MB image / 24 MB batch limit.");
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
