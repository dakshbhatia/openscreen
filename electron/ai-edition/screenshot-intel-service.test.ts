import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTEL_SETTINGS } from "../../src/lib/product-intel";
import { MAX_SCREENSHOT_BYTES, type ScreenshotAnalysis } from "../../src/lib/screenshot-intel";
import { ScreenshotIntelService } from "./screenshot-intel-service";

let root: string;
let originals: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-screenshots-"));
	originals = path.join(root, "originals");
	await fs.mkdir(originals);
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

async function image(
	name = "screen.png",
	format: "png" | "jpeg" | "webp" = "png",
	width = 320,
	height = 240,
): Promise<string> {
	const file = path.join(originals, name);
	await sharp({ create: { width, height, channels: 3, background: "#25405f" } })
		.toFormat(format)
		.toFile(file);
	return file;
}

type GeminiBody = {
	systemInstruction: { parts: { text: string }[] };
	contents: { parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
	generationConfig: { responseMimeType: string; responseJsonSchema: unknown };
};
function google(transform: (analysis: ScreenshotAnalysis) => unknown = (analysis) => analysis) {
	const requests: { url: string; init?: RequestInit; body: GeminiBody }[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const body = JSON.parse(String(init?.body)) as GeminiBody;
		requests.push({ url: String(input), init, body });
		const ids = body.contents[0].parts.flatMap((part) =>
			"text" in part && part.text.startsWith("imageId: ") ? [part.text.slice(9)] : [],
		);
		const analysis: ScreenshotAnalysis = {
			summary: "Setup is prominent; test a smaller first step for solo architects.",
			screens: ids.map((imageId) => ({
				imageId,
				label: "Create workspace",
				group: "Setup",
				observation: "A name field is visible.",
				hypothesis: "A team name may organize shared work.",
				advice:
					"Test postponing the team name for solo architects; check whether they can start a project and still recognize their workspace.",
				confidence: "medium",
			})),
			unknowns: ["The screenshots do not establish flow order or conversion impact."],
		};
		return Response.json({
			candidates: [
				{
					content: {
						parts: [
							{ thought: true, text: "private thinking" },
							{ text: JSON.stringify(transform(analysis)) },
						],
					},
				},
			],
		});
	};
	return { requests, fetcher };
}

function service(key: string | null = "test-gemini-key", fetcher: typeof fetch = vi.fn()) {
	return new ScreenshotIntelService(
		root,
		async () => ({ ...DEFAULT_INTEL_SETTINGS, productBrief: "A tool for solo architects" }),
		() => key,
		fetcher,
	);
}

describe("ScreenshotIntelService", () => {
	it("imports decoded PNG, JPEG and WebP into managed storage without changing originals", async () => {
		const paths = [
			await image(),
			await image("second.jpg", "jpeg"),
			await image("third.webp", "webp"),
		];
		const before = await Promise.all(paths.map((file) => fs.readFile(file)));
		const intel = service();
		expect(await intel.list()).toEqual([]);
		const batch = await intel.import(paths);
		expect(batch.images.map((item) => item.mimeType)).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
		]);
		expect(batch.analysis).toBeNull();
		expect(batch).not.toHaveProperty("duplicatesSkipped");
		for (const [index, imported] of batch.images.entries()) {
			expect(imported.width).toBe(320);
			expect(imported.height).toBe(240);
			expect(
				imported.path.startsWith(path.join(root, "screenshot-intel", batch.id, "images")),
			).toBe(true);
			expect(await fs.readFile(imported.path)).toEqual(before[index]);
			expect(await fs.readFile(paths[index])).toEqual(before[index]);
		}
		expect(await intel.get(batch.id)).toEqual(batch);
		expect(await intel.list()).toEqual([batch]);
	});
	it("skips exact byte duplicates, preserves the first image and originals, and analyzes only survivors", async () => {
		const first = await image("first.png");
		const duplicate = path.join(originals, "duplicate.png");
		const anotherDuplicate = path.join(originals, "another.png");
		await fs.copyFile(first, duplicate);
		await fs.copyFile(first, anotherDuplicate);
		const unique = await image("unique.png", "png", 321);
		const paths = [first, duplicate, unique, anotherDuplicate];
		const before = await Promise.all(paths.map((file) => fs.readFile(file)));
		const { fetcher, requests } = google();
		const intel = service("test-gemini-key", fetcher);
		const batch = await intel.import(paths);
		expect(batch.duplicatesSkipped).toBe(2);
		expect(batch.images.map((item) => item.originalName)).toEqual(["first.png", "unique.png"]);
		expect(await fs.readdir(path.dirname(batch.images[0].path))).toHaveLength(2);
		expect(await Promise.all(paths.map((file) => fs.readFile(file)))).toEqual(before);
		expect((await intel.get(batch.id)).duplicatesSkipped).toBe(2);
		const result = await intel.analyze(batch.id);
		expect(result.duplicatesSkipped).toBe(2);
		expect(result.analysis?.screens.map((screen) => screen.imageId)).toEqual(
			batch.images.map((item) => item.id),
		);
		expect(requests[0].body.contents[0].parts.filter((part) => "inlineData" in part)).toHaveLength(
			2,
		);
	});
	it("keeps one valid image when every supplied file has identical bytes", async () => {
		const first = await image();
		const duplicate = path.join(originals, "duplicate.png");
		await fs.copyFile(first, duplicate);
		const batch = await service().import([first, duplicate]);
		expect(batch.images).toHaveLength(1);
		expect(batch.images[0].originalName).toBe("screen.png");
		expect(batch.duplicatesSkipped).toBe(1);
	});
	it("still rolls back skipped duplicates if a later file is invalid", async () => {
		const first = await image();
		const duplicate = path.join(originals, "duplicate.png");
		await fs.copyFile(first, duplicate);
		const broken = path.join(originals, "broken.png");
		await fs.writeFile(broken, "not an image");
		const intel = service();
		await expect(intel.import([first, duplicate, broken])).rejects.toThrow(/valid.*PNG/i);
		expect(await intel.list()).toEqual([]);
		expect(await fs.readdir(path.join(root, "screenshot-intel"))).toEqual([]);
		expect(await fs.readFile(duplicate)).toEqual(await fs.readFile(first));
	});

	it("rolls back the whole managed batch if any image is invalid", async () => {
		const valid = await image();
		const invalid = path.join(originals, "broken.png");
		await fs.writeFile(invalid, "not an image");
		const intel = service();
		await expect(intel.import([valid, invalid])).rejects.toThrow(/valid.*PNG/i);
		expect(await fs.readdir(path.join(root, "screenshot-intel"))).toEqual([]);
		expect(await fs.readFile(invalid, "utf8")).toBe("not an image");
		expect(await intel.list()).toEqual([]);
	});
	it("rejects unsupported decoded formats even when the filename says PNG", async () => {
		const invalid = path.join(originals, "vector.png");
		await fs.writeFile(
			invalid,
			'<svg width="100" height="100"><rect width="100" height="100"/></svg>',
		);
		await expect(service().import([invalid])).rejects.toThrow(/valid.*PNG/i);
	});
	it("caps image count, duplicate inputs, individual bytes and total batch bytes before copying", async () => {
		const valid = await image();
		const intel = service();
		await expect(intel.import([])).rejects.toThrow(/1 to 24/);
		await expect(intel.import(Array.from({ length: 25 }, () => valid))).rejects.toThrow(/1 to 24/);
		await expect(intel.import([valid, valid])).rejects.toThrow(/only once/);
		const large = path.join(originals, "large.png");
		await fs.writeFile(large, "");
		await fs.truncate(large, MAX_SCREENSHOT_BYTES + 1);
		await expect(intel.import([large])).rejects.toThrow(/8 MB/);
		const many = [];
		for (let index = 0; index < 4; index++) {
			const file = path.join(originals, `large-${index}.png`);
			await fs.writeFile(file, "");
			await fs.truncate(file, MAX_SCREENSHOT_BYTES);
			many.push(file);
		}
		await expect(intel.import(many)).rejects.toThrow(/24 MB/);
		expect(await intel.list()).toEqual([]);
	});
	it("does not send images without a Gemini key", async () => {
		const { fetcher, requests } = google();
		const intel = service(null, fetcher);
		const batch = await intel.import([await image()]);
		await expect(intel.analyze(batch.id)).rejects.toThrow(/Gemini.*key/i);
		expect(requests).toHaveLength(0);
		expect((await intel.get(batch.id)).analysis).toBeNull();
	});
	it("sends identified, resized native inline images with product context and persists organized names", async () => {
		const { fetcher, requests } = google();
		const intel = service("test-gemini-key", fetcher);
		const batch = await intel.import([
			await image("wide.png", "png", 3000, 600),
			await image("other.png"),
		]);
		const result = await intel.analyze(batch.id);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toContain(`/models/${DEFAULT_INTEL_SETTINGS.model}:generateContent`);
		expect(requests[0].init?.headers).toEqual({
			"content-type": "application/json",
			"x-goog-api-key": "test-gemini-key",
		});
		const body = requests[0].body;
		expect(body.systemInstruction.parts[0].text).toContain("Never infer chronology");
		expect(JSON.stringify(body.contents)).toContain("A tool for solo architects");
		expect(JSON.stringify(body)).not.toContain(originals);
		expect(JSON.stringify(body)).not.toContain("test-gemini-key");
		expect(body.generationConfig.responseMimeType).toBe("application/json");
		const inline = body.contents[0].parts.flatMap((part) =>
			"inlineData" in part ? [part.inlineData] : [],
		);
		expect(inline).toHaveLength(2);
		expect(inline[0].mimeType).toBe("image/webp");
		const resized = await sharp(Buffer.from(inline[0].data, "base64")).metadata();
		expect(resized.width).toBe(2000);
		expect(resized.height).toBe(400);
		expect(result.analysis?.screens).toHaveLength(2);
		expect(result.settings?.productBrief).toBe("A tool for solo architects");
		expect(result.analyzedAt).toBeTruthy();
		expect(result.organizedPath).toBe(path.join(root, "screenshot-intel", batch.id, "organized"));
		const groups = await fs.readdir(result.organizedPath ?? "");
		expect(groups).toHaveLength(1);
		const names = await fs.readdir(path.join(result.organizedPath ?? "", groups[0]));
		expect(names).toHaveLength(2);
		expect(
			names.every((name) => name.startsWith("create-workspace-image_") && name.endsWith(".png")),
		).toBe(true);
		expect(new Set(names).size).toBe(2);
		expect(await intel.get(batch.id)).toEqual(result);
		expect(JSON.stringify(result)).not.toContain("test-gemini-key");
		expect(await intel.organize(batch.id)).toEqual(result);
		expect(await fs.readdir(result.organizedPath ?? "")).toEqual(groups);
	});
	it.each([
		401, 403, 429, 404, 400, 503, 418,
	])("returns safe actionable HTTP %s errors without reading provider bodies", async (status) => {
		const response = new Response("PRIVATE_PROVIDER_BODY secret-key /Users/private", { status });
		const intel = service("secret-key", async () => response);
		const batch = await intel.import([await image()]);
		const error = await intel.analyze(batch.id).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(`HTTP ${status}`);
		expect((error as Error).message).not.toMatch(/PRIVATE_PROVIDER_BODY|secret-key|Users/);
		expect(response.bodyUsed).toBe(false);
		expect((await intel.get(batch.id)).analysis).toBeNull();
	});

	it("never accepts repeated, missing or phantom AI image IDs", async () => {
		const { fetcher } = google((analysis) => ({
			...analysis,
			screens: [analysis.screens[0], analysis.screens[0]],
		}));
		const intel = service("key", fetcher);
		const batch = await intel.import([await image(), await image("second.png", "png", 321)]);
		await expect(intel.analyze(batch.id)).rejects.toThrow(/exactly once/i);
		expect((await intel.get(batch.id)).analysis).toBeNull();
		expect(await fs.readdir(path.join(root, "screenshot-intel", batch.id))).toEqual([
			"batch.json",
			"images",
		]);
	});
	it("sanitizes AI names and groups and prevents naming collisions", async () => {
		const { fetcher } = google((analysis) => ({
			...analysis,
			screens: analysis.screens.map((screen, index) => ({
				...screen,
				label: "../../Secrets:Screen",
				group: index ? "../A/B" : "../A:B",
			})),
		}));
		const intel = service("key", fetcher);
		const batch = await intel.import([await image(), await image("second.png", "png", 321)]);
		const result = await intel.analyze(batch.id);
		const groups = await fs.readdir(result.organizedPath ?? "");
		expect(groups).toHaveLength(2);
		expect(groups.every((group) => /^a-b-[a-f0-9]{8}$/.test(group))).toBe(true);
		for (const group of groups) {
			const names = await fs.readdir(path.join(result.organizedPath ?? "", group));
			expect(names).toHaveLength(1);
			expect(names[0]).toMatch(/^secrets-screen-image_[a-f0-9-]+\.png$/);
		}
		expect((await fs.readdir(root)).sort()).toEqual(["originals", "screenshot-intel"]);
	});
	it("rejects invalid IDs and disk-edited paths before reading image data", async () => {
		const { fetcher, requests } = google();
		const intel = service("key", fetcher);
		await expect(intel.get("../../secrets")).rejects.toThrow();
		await expect(intel.analyze("../../secrets")).rejects.toThrow();
		expect(() => intel.cancel("../../secrets")).toThrow();
		const batch = await intel.import([await image()]);
		const file = path.join(root, "screenshot-intel", batch.id, "batch.json");
		await fs.writeFile(
			file,
			JSON.stringify({
				...batch,
				images: [{ ...batch.images[0], path: path.join(originals, "secret.png") }],
			}),
		);
		await expect(intel.analyze(batch.id)).rejects.toThrow(/could not be read/);
		expect(requests).toHaveLength(0);
		await fs.writeFile(file, JSON.stringify({ ...batch, organizedPath: originals }));
		await expect(intel.get(batch.id)).rejects.toThrow(/could not be read/);
		expect(await intel.list()).toEqual([]);
	});
	it("cancels a running request, excludes concurrent analyses and keeps imported images", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		);
		const intel = service("key", fetcher);
		const batch = await intel.import([await image()]);
		const pending = intel.analyze(batch.id);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		await expect(intel.analyze(batch.id)).rejects.toThrow(/already/);
		await expect(intel.organize(batch.id)).rejects.toThrow(/Wait/);
		intel.cancel(batch.id);
		await expect(pending).rejects.toThrow(/cancelled/i);
		expect((await intel.get(batch.id)).analysis).toBeNull();
		expect(await fs.readFile(batch.images[0].path)).toEqual(
			await fs.readFile(path.join(originals, "screen.png")),
		);
	});
	it("times out requests after ten minutes without persisting partial analysis", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		);
		const intel = service("key", fetcher);
		const batch = await intel.import([await image()]);
		vi.useFakeTimers();
		const pending = intel.analyze(batch.id);
		const rejected = expect(pending).rejects.toThrow(/timed out/);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		await rejected;
		expect((await intel.get(batch.id)).analysis).toBeNull();
	});
	it("retains the prior report and organized copies when reanalysis organization fails", async () => {
		const { fetcher } = google();
		const intel = service("key", fetcher);
		const batch = await intel.import([await image()]);
		const first = await intel.analyze(batch.id);
		const before = await fs.readdir(first.organizedPath ?? "", { recursive: true });
		vi.spyOn(fs, "copyFile").mockRejectedValueOnce(new Error("disk full"));
		await expect(intel.analyze(batch.id)).rejects.toThrow(/disk full/);
		expect(await intel.get(batch.id)).toEqual(first);
		expect(await fs.readdir(first.organizedPath ?? "", { recursive: true })).toEqual(before);
		expect((await fs.readdir(path.join(root, "screenshot-intel", batch.id))).sort()).toEqual([
			"batch.json",
			"images",
			"organized",
		]);
	});
});
