import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseCompanyContext } from "../../src/lib/company-context";
import {
	buildProductPrompt,
	DEFAULT_INTEL_SETTINGS,
	type IntelReport,
	type IntelSettings,
	intelReportSchema,
	intelSettingsSchema,
	PRODUCT_RECORDING_BRIEF_RULES,
	parseProductAnalysis,
	productAnalysisSchema,
	productDecisionSchema,
	productJourneySchema,
	productPieceSchema,
	productReadoutInsightSchema,
	productReadoutSchema,
	productUnderstandingSchema,
} from "../../src/lib/product-intel";
import { PRODUCT_REASONING_RULES } from "../../src/lib/product-reasoning";
import { geminiHttpError } from "./gemini-errors";

const API = "https://generativelanguage.googleapis.com";
// Large bounded arrays make Google's response grammar reject otherwise valid
// requests. Keep those limits in local validation, outside the wire schema.
const currentAnalysisSchema = productAnalysisSchema.extend({
	understanding: productUnderstandingSchema,
	readout: productReadoutSchema,
	decisions: z.array(productDecisionSchema).max(3),
	pieces: z.array(productPieceSchema).max(12),
	journey: productJourneySchema,
});
const geminiInsightSchema = productReadoutInsightSchema.extend({
	evidenceTimesSec: z.array(z.number().finite().nonnegative()),
});
const geminiAnalysisSchema = currentAnalysisSchema.extend({
	steps: z.array(productAnalysisSchema.shape.steps.element),
	findings: z.array(productAnalysisSchema.shape.findings.element),
	unknowns: z.array(productAnalysisSchema.shape.unknowns.element),
	readout: z.strictObject({
		strengths: z.array(geminiInsightSchema),
		frictions: z.array(geminiInsightSchema),
	}),
	decisions: z.array(
		productDecisionSchema.extend({ evidenceTimesSec: z.array(z.number().finite().nonnegative()) }),
	),
	pieces: z.array(productPieceSchema),
	journey: z.strictObject({
		...productJourneySchema.shape,
		stages: z.array(
			productJourneySchema.shape.stages.element.extend({
				evidenceTimesSec: z.array(z.number().finite().nonnegative()),
			}),
		),
	}),
});
const sourceMime: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".avi": "video/avi",
	".wmv": "video/wmv",
	".m4v": "video/mp4",
	".mpeg": "video/mpeg",
};
const remoteFileName = z.string().regex(/^files\/[A-Za-z0-9_-]+$/);
const fileSchema = z.object({
	name: remoteFileName,
	uri: z.string().url(),
	state: z
		.enum(["STATE_UNSPECIFIED", "PROCESSING", "ACTIVE", "FAILED"])
		.default("STATE_UNSPECIFIED"),
});
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
export interface IntelSource {
	assetId: string;
	path: string;
	durationSec: number;
}

export class ProductIntelService {
	private readonly root: string;
	private settingsWrites: Promise<void> = Promise.resolve();
	private jobs = new Map<string, { controller: AbortController; status: string }>();
	constructor(
		userData: string,
		private readonly loadSource: (projectId: string) => Promise<IntelSource>,
		private readonly apiKey: () => string | null,
		private readonly fetcher: typeof fetch = fetch,
	) {
		this.root = path.join(userData, "product-intel");
	}
	private projectPath(projectId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project id");
		return path.join(this.root, `${projectId}.json`);
	}
	private async write(file: string, value: unknown): Promise<void> {
		await fs.mkdir(this.root, { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
			await fs.rename(temp, file);
		} finally {
			await fs.rm(temp, { force: true });
		}
	}
	async getSettings(): Promise<IntelSettings> {
		try {
			return intelSettingsSchema.parse(
				JSON.parse(await fs.readFile(path.join(this.root, "settings.json"), "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_INTEL_SETTINGS };
			throw new Error("Product analysis settings could not be read.");
		}
	}
	async saveSettings(settings: IntelSettings): Promise<IntelSettings> {
		const parsed = intelSettingsSchema.parse(settings);
		const write = this.settingsWrites.then(() =>
			this.write(path.join(this.root, "settings.json"), parsed),
		);
		// Keep later context saves ordered even if an earlier disk write fails.
		this.settingsWrites = write.catch(() => {
			/* The initiating caller receives the error below. */
		});
		await write;
		return parsed;
	}
	async getReport(projectId: string): Promise<IntelReport | null> {
		const file = this.projectPath(projectId);
		try {
			return intelReportSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error("Saved product analysis could not be read.");
		}
	}
	getStatus(projectId: string): string | null {
		return this.jobs.get(projectId)?.status ?? null;
	}
	async snapshot(projectId?: string) {
		return {
			settings: await this.getSettings(),
			report: projectId ? await this.getReport(projectId) : null,
			connected: Boolean(this.apiKey()),
			status: projectId ? this.getStatus(projectId) : null,
		};
	}
	cancel(projectId: string): void {
		this.jobs.get(projectId)?.controller.abort();
	}

	async analyze(projectId: string, reuse = false): Promise<IntelReport> {
		const file = this.projectPath(projectId);
		if (this.jobs.has(projectId)) throw new Error("This recording is already being analyzed.");
		const controller = new AbortController();
		const job = { controller, status: "Preparing recording" };
		this.jobs.set(projectId, job);
		const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
		let remoteName: string | null = null;
		let key: string | null = null;
		let report: IntelReport | null = null;
		const request = async (url: string, init: RequestInit = {}) => {
			controller.signal.throwIfAborted();
			const response = await this.fetcher(url, {
				...init,
				signal: controller.signal,
				headers: { "x-goog-api-key": key ?? "", ...init.headers },
			});
			if (!response.ok) throw geminiHttpError(response.status, "recording");
			return response;
		};
		try {
			try {
				key = this.apiKey();
				if (!key) throw new Error("Add a Gemini API key to analyze product flows.");
				const settings = await this.getSettings();
				const source = await this.loadSource(projectId);
				if (!Number.isFinite(source.durationSec) || source.durationSec <= 0)
					throw new Error("Wait for the recording duration to load, then retry.");
				const stat = await fs.stat(source.path);
				if (!stat.isFile() || stat.size === 0 || stat.size > 2_000_000_000)
					throw new Error("Choose a non-empty recording smaller than 2 GB.");
				const mimeType = sourceMime[path.extname(source.path).toLowerCase()];
				if (!mimeType) throw new Error("Use an MP4, MOV or WebM recording for Gemini analysis.");
				const sourceFingerprint = createHash("sha256")
					.update(
						JSON.stringify([
							source.assetId,
							source.path,
							source.durationSec,
							stat.size,
							stat.mtimeMs,
							settings,
							PRODUCT_REASONING_RULES,
							PRODUCT_RECORDING_BRIEF_RULES,
						]),
					)
					.digest("hex");
				if (reuse) {
					const saved = await this.getReport(projectId);
					if (saved?.sourceFingerprint === sourceFingerprint) return saved;
				}
				job.status = "Uploading recording";
				const start = await request(`${API}/upload/v1beta/files`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"X-Goog-Upload-Protocol": "resumable",
						"X-Goog-Upload-Command": "start",
						"X-Goog-Upload-Header-Content-Length": String(stat.size),
						"X-Goog-Upload-Header-Content-Type": mimeType,
					},
					body: JSON.stringify({ file: { display_name: "Product flow" } }),
				});
				const uploadUrl = start.headers.get("x-goog-upload-url");
				if (!uploadUrl || new URL(uploadUrl).origin !== API)
					throw new Error("Gemini returned an invalid upload endpoint.");
				const stream = createReadStream(source.path);
				let uploaded: z.infer<typeof fileSchema>;
				try {
					const init: RequestInit & { duplex: "half" } = {
						method: "POST",
						headers: {
							"content-type": mimeType,
							"content-length": String(stat.size),
							"X-Goog-Upload-Offset": "0",
							"X-Goog-Upload-Command": "upload, finalize",
						},
						body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
						duplex: "half",
					};
					const raw: unknown = await (await request(uploadUrl, init)).json();
					// Keep the validated remote name even if other metadata is unusable,
					// so every finalized upload can still be removed in finally.
					remoteName = z.object({ file: z.object({ name: remoteFileName }) }).parse(raw).file.name;
					uploaded = z.object({ file: fileSchema }).parse(raw).file;
				} finally {
					stream.destroy();
				}
				job.status = "Processing video";
				while (uploaded.state === "PROCESSING" || uploaded.state === "STATE_UNSPECIFIED") {
					await delay(2000, undefined, { signal: controller.signal });
					uploaded = fileSchema.parse(
						await (await request(`${API}/v1beta/${uploaded.name}`)).json(),
					);
				}
				if (uploaded.state !== "ACTIVE")
					throw new Error("Gemini could not process this recording. Try exporting it as MP4.");
				job.status = "Analyzing through your product lens";
				const { $schema: _schema, ...responseJsonSchema } = z.toJSONSchema(geminiAnalysisSchema);
				const response = replySchema.parse(
					await (
						await request(`${API}/v1beta/models/${settings.model}:generateContent`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								systemInstruction: {
									parts: [
										{
											text: `${settings.systemPrompt}\n\n${PRODUCT_REASONING_RULES}\n\n${PRODUCT_RECORDING_BRIEF_RULES}`,
										},
									],
								},
								contents: [
									{
										role: "user",
										parts: [
											{ fileData: { mimeType, fileUri: uploaded.uri }, videoMetadata: { fps: 2 } },
											{
												text: `${buildProductPrompt(settings)}\nSource duration: ${source.durationSec} seconds. All timestamps must be within this duration.`,
											},
										],
									},
								],
								...(settings.companyDomain ? { tools: [{ urlContext: {} }] } : {}),
								generationConfig: {
									responseMimeType: "application/json",
									responseJsonSchema,
									maxOutputTokens: 12000,
								},
							}),
						})
					).json(),
				);
				const candidate = response.candidates?.[0];
				const text = candidate?.content?.parts
					.filter((p) => !p.thought)
					.map((p) => p.text ?? "")
					.join("");
				if (!text)
					throw new Error("Gemini returned no analysis. Try a shorter recording or another model.");
				const analysis = parseProductAnalysis(
					currentAnalysisSchema.parse(JSON.parse(text)),
					source.durationSec,
				);
				controller.signal.throwIfAborted();
				report = {
					projectId,
					assetId: source.assetId,
					durationSec: source.durationSec,
					createdAt: new Date().toISOString(),
					sourceFingerprint,
					settings,
					analysis,
					remoteFileDeleted: false,
					...(settings.companyDomain
						? {
								companyContext: parseCompanyContext(
									settings.companyDomain,
									candidate?.urlContextMetadata,
								),
							}
						: {}),
				};
			} catch (error) {
				if (controller.signal.aborted)
					throw new Error("Analysis cancelled or timed out. Your local recording is safe.");
				throw error;
			} finally {
				if (remoteName && key) {
					try {
						const removed = await this.fetcher(`${API}/v1beta/${remoteName}`, {
							method: "DELETE",
							headers: { "x-goog-api-key": key },
							signal: AbortSignal.timeout(10000),
						});
						if (report) report.remoteFileDeleted = removed.ok || removed.status === 404;
					} catch {
						/* Google expires uploaded Files automatically; expose failed cleanup on the report. */
					}
				}
			}
			if (controller.signal.aborted)
				throw new Error("Analysis cancelled or timed out. Your local recording is safe.");
			if (!report) throw new Error("Analysis could not be completed.");
			await this.write(file, report);
			return report;
		} finally {
			clearTimeout(timeout);
			this.jobs.delete(projectId);
		}
	}
}
