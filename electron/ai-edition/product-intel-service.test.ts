import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTEL_SETTINGS } from "../../src/lib/product-intel";
import { PRODUCT_REASONING_RULES } from "../../src/lib/product-reasoning";
import { ProductIntelService } from "./product-intel-service";

const analysis = {
	summary: "Workspace setup",
	steps: [{ timeSec: 1, action: "Create workspace", evidence: "A form opens" }],
	findings: [],
	unknowns: ["No revenue data"],
};
let root: string;
let media: string;
const loadSource = async () => ({ assetId: "asset_1", path: media, durationSec: 10 });

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-intel-"));
	media = path.join(root, "flow.mp4");
	await fs.writeFile(media, "test-media");
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

function service(apiKey: string | null = "test-key", fetcher: typeof fetch = vi.fn()) {
	return new ProductIntelService(root, loadSource, () => apiKey, fetcher);
}

function google() {
	const requests: { url: string; init?: RequestInit }[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.endsWith("/upload/v1beta/files"))
			return new Response(null, {
				headers: {
					"x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session",
				},
			});
		if (url.endsWith("/upload/session"))
			return Response.json({
				file: {
					name: "files/123",
					uri: "https://generativelanguage.googleapis.com/v1beta/files/123",
					state: "ACTIVE",
				},
			});
		if (init?.method === "DELETE") return new Response(null, { status: 200 });
		return Response.json({
			candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }],
		});
	};
	return { fetcher, requests };
}

describe("ProductIntelService", () => {
	it("defaults to manual analysis and persists a reusable product lens", async () => {
		const first = service();
		expect((await first.getSettings()).autoAnalyze).toBe(false);
		await first.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "A tool for small studios",
		});
		expect((await service().getSettings()).productBrief).toBe("A tool for small studios");
	});
	it("keeps the latest brief when an earlier real file write is delayed", async () => {
		const writeFile = fs.writeFile.bind(fs);
		let releaseEarlier: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const earlierBlocked = new Promise<void>((resolve) => {
			releaseEarlier = resolve;
		});
		const earlierStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const writes: string[] = [];
		vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			const contents = String(args[1]);
			writes.push(contents);
			if (contents.includes('"productBrief": "Earlier context"')) {
				markStarted?.();
				await earlierBlocked;
			}
			return writeFile(...args);
		});
		const intel = service();
		const earlier = intel.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "Earlier context",
		});
		await earlierStarted;
		const latest = intel.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "Latest context",
		});
		try {
			// An unqueued newer write finishes while the older one is blocked, then
			// loses its context when the older temp file is finally renamed.
			expect(await Promise.race([latest.then(() => "finished"), delay(50, "blocked")])).toBe(
				"blocked",
			);
			expect(writes).toHaveLength(1);
		} finally {
			releaseEarlier?.();
			await Promise.all([earlier, latest]);
		}
		expect((await service().getSettings()).productBrief).toBe("Latest context");
	});
	it("continues saving newer context after an earlier disk write rejects", async () => {
		const writeFile = fs.writeFile.bind(fs);
		vi.spyOn(fs, "writeFile")
			.mockRejectedValueOnce(new Error("Disk write failed"))
			.mockImplementation(writeFile);
		const intel = service();
		const failed = intel.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "Failed context",
		});
		const recovered = intel.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "Recovered context",
		});
		await expect(failed).rejects.toThrow("Disk write failed");
		await expect(recovered).resolves.toMatchObject({ productBrief: "Recovered context" });
		expect((await service().getSettings()).productBrief).toBe("Recovered context");
	});

	it("does not upload without a configured Gemini key", async () => {
		const { fetcher, requests } = google();
		await expect(service(null, fetcher).analyze("proj_1")).rejects.toThrow(/Gemini.*key/i);
		expect(requests).toHaveLength(0);
	});
	it("uploads raw video, uses the product lens, saves evidence and deletes the remote file", async () => {
		const { fetcher, requests } = google();
		const intel = service("test-key", fetcher);
		await intel.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			productBrief: "A tool for small studios",
		});
		const report = await intel.analyze("proj_1");
		expect(report.analysis.summary).toBe("Workspace setup");
		expect((await intel.getReport("proj_1"))?.assetId).toBe("asset_1");
		const body = JSON.parse(
			String(requests.find((r) => r.url.includes(":generateContent"))?.init?.body),
		);
		expect(body.contents[0].parts[1].text).toContain("A tool for small studios");
		expect(body.contents[0].parts[0].fileData.fileUri).toContain("files/123");
		expect(JSON.stringify(body.generationConfig.responseJsonSchema)).not.toContain("maxItems");
		expect(requests.at(-1)?.init?.method).toBe("DELETE");
		expect(JSON.stringify(report)).not.toContain("test-key");
	});
	it("appends current reasoning after a saved custom prompt without rewriting settings", async () => {
		const base = google();
		const intel = service("test-key", base.fetcher);
		const prompt = "My custom lens!!\nPreserve me.";
		await intel.saveSettings({ ...DEFAULT_INTEL_SETTINGS, systemPrompt: prompt });
		const report = await intel.analyze("proj_1");
		const request = base.requests.find((item) => item.url.includes(":generateContent"));
		const body = JSON.parse(String(request?.init?.body)) as {
			systemInstruction: { parts: { text: string }[] };
			tools?: unknown;
		};
		expect(body.systemInstruction.parts[0].text).toBe(`${prompt}\n\n${PRODUCT_REASONING_RULES}`);
		expect(body.systemInstruction.parts[0].text).toContain(
			"Successfully retrieved company content supplies product context even without a written brief",
		);
		expect(body.tools).toBeUndefined();
		expect(report.settings.systemPrompt).toBe(prompt);
		expect((await intel.getSettings()).systemPrompt).toBe(prompt);
	});
	it.each([
		true,
		false,
	])("adds optional company URL context and uses retrieval metadata only (retrieved=%s)", async (retrieved) => {
		const base = google();
		const fetcher: typeof fetch = async (url, init) => {
			const response = await base.fetcher(url, init);
			if (!String(url).includes(":generateContent")) return response;
			const raw = (await response.json()) as { candidates: { urlContextMetadata?: unknown }[] };
			if (retrieved)
				raw.candidates[0].urlContextMetadata = {
					urlMetadata: [
						{
							retrievedUrl: "https://example.com/about",
							urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
						},
					],
				};
			return Response.json(raw);
		};
		const intel = service("test-key", fetcher);
		await intel.saveSettings({
			...DEFAULT_INTEL_SETTINGS,
			companyDomain: "https://example.com",
		});
		const report = await intel.analyze("proj_1");
		const request = base.requests.find((item) => item.url.includes(":generateContent"));
		const body = JSON.parse(String(request?.init?.body)) as { tools?: unknown; contents: unknown };
		expect(body.tools).toEqual([{ urlContext: {} }]);
		expect(JSON.stringify(body.contents)).toContain("https://example.com");
		expect(report.companyContext?.status).toBe(retrieved ? "retrieved" : "unavailable");
		expect(report.companyContext?.sourceUrls).toEqual(
			retrieved ? ["https://example.com/about"] : [],
		);
		expect((await intel.getReport("proj_1"))?.companyContext).toEqual(report.companyContext);
	});

	it.each([
		401, 403, 429, 404, 400, 503, 418,
	])("returns safe HTTP %s recovery guidance and still deletes video uploads", async (status) => {
		const base = google();
		const response = new Response("PRIVATE_PROVIDER_BODY secret-key /Users/private", { status });
		const intel = service("secret-key", async (url, init) =>
			String(url).includes(":generateContent") ? response : base.fetcher(url, init),
		);
		const error = await intel.analyze("proj_1").catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(`HTTP ${status}`);
		expect((error as Error).message).not.toMatch(/PRIVATE_PROVIDER_BODY|secret-key|Users/);
		expect(response.bodyUsed).toBe(false);
		expect(await intel.getReport("proj_1")).toBeNull();
		expect(base.requests.at(-1)?.init?.method).toBe("DELETE");
	});

	it("enforces local array limits even though the wire schema omits them", async () => {
		const base = google();
		const fetcher: typeof fetch = async (url, init) => {
			if (String(url).includes(":generateContent"))
				return Response.json({
					candidates: [
						{
							content: {
								parts: [
									{
										text: JSON.stringify({
											...analysis,
											steps: Array.from({ length: 81 }, () => analysis.steps[0]),
										}),
									},
								],
							},
						},
					],
				});
			return base.fetcher(url, init);
		};
		const intel = service("test-key", fetcher);
		await expect(intel.analyze("proj_1")).rejects.toThrow();
		expect(await intel.getReport("proj_1")).toBeNull();
		expect(base.requests.at(-1)?.init?.method).toBe("DELETE");
	});
	it("reuses a matching report for auto analysis and refreshes after the brief changes", async () => {
		const { fetcher, requests } = google();
		const intel = service("test-key", fetcher);
		await intel.analyze("proj_1");
		const count = requests.length;
		await intel.analyze("proj_1", true);
		expect(requests.length).toBe(count);
		await intel.saveSettings({ ...DEFAULT_INTEL_SETTINGS, productBrief: "Different audience" });
		await intel.analyze("proj_1", true);
		expect(requests.length).toBeGreaterThan(count);
	});
	it("blocks project traversal before reading or writing reports", async () => {
		await expect(service().getReport("../secret")).rejects.toThrow(/project/i);
	});
	it("refreshes cached evidence when the measured source duration changes", async () => {
		const { fetcher, requests } = google();
		let durationSec = 10;
		const intel = new ProductIntelService(
			root,
			async () => ({ ...(await loadSource()), durationSec }),
			() => "test-key",
			fetcher,
		);
		await intel.analyze("proj_1");
		const count = requests.length;
		durationSec = 20;
		const updated = await intel.analyze("proj_1", true);
		expect(requests.length).toBeGreaterThan(count);
		expect(updated.durationSec).toBe(20);
	});
	it("deletes a finalized upload even when its metadata cannot be used", async () => {
		const base = google();
		const fetcher: typeof fetch = async (url, init) =>
			String(url).endsWith("/upload/session")
				? Response.json({ file: { name: "files/123", uri: "invalid", state: "ACTIVE" } })
				: base.fetcher(url, init);
		await expect(service("test-key", fetcher).analyze("proj_1")).rejects.toThrow();
		expect(base.requests.at(-1)?.init?.method).toBe("DELETE");
	});
	it("polls an upload whose initial processing state is omitted", async () => {
		const base = google();
		const metadata = {
			name: "files/123",
			uri: "https://generativelanguage.googleapis.com/v1beta/files/123",
		};
		const fetcher: typeof fetch = async (url, init) => {
			if (String(url).endsWith("/upload/session")) return Response.json({ file: metadata });
			if (String(url).endsWith("/v1beta/files/123") && !init?.method)
				return Response.json({ ...metadata, state: "ACTIVE" });
			return base.fetcher(url, init);
		};
		const result = await service("test-key", fetcher).analyze("proj_1");
		expect(result.analysis.summary).toBe(analysis.summary);
		expect(result.remoteFileDeleted).toBe(true);
	});
	it("rejects invented timestamps and still removes the uploaded recording", async () => {
		const base = google();
		const fetcher: typeof fetch = async (url, init) => {
			if (String(url).includes(":generateContent"))
				return Response.json({
					candidates: [
						{
							content: {
								parts: [
									{
										text: JSON.stringify({
											...analysis,
											steps: [{ timeSec: 99, action: "Invented step", evidence: "Outside video" }],
										}),
									},
								],
							},
						},
					],
				});
			return base.fetcher(url, init);
		};
		const intel = service("test-key", fetcher);
		await expect(intel.analyze("proj_1")).rejects.toThrow(/timestamp outside/i);
		expect(base.requests.at(-1)?.init?.method).toBe("DELETE");
		expect(await intel.getReport("proj_1")).toBeNull();
	});
	it("can cancel a running analysis and leaves no completed report", async () => {
		const fetcher: typeof fetch = async (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
					once: true,
				});
			});
		const intel = service("test-key", fetcher);
		const pending = intel.analyze("proj_1");
		await vi.waitFor(() => expect(intel.getStatus("proj_1")).toBe("Uploading recording"));
		intel.cancel("proj_1");
		await expect(pending).rejects.toThrow(/cancel/i);
		expect(await intel.getReport("proj_1")).toBeNull();
	});
	it("honors cancellation during remote file cleanup", async () => {
		const base = google();
		let finishCleanup: (() => void) | undefined;
		const fetcher: typeof fetch = async (url, init) => {
			if (init?.method === "DELETE") {
				await new Promise<void>((resolve) => {
					finishCleanup = resolve;
				});
				return new Response(null, { status: 200 });
			}
			return base.fetcher(url, init);
		};
		const intel = service("test-key", fetcher);
		const pending = intel.analyze("proj_1");
		await vi.waitFor(() => expect(finishCleanup).toBeDefined());
		await expect(intel.analyze("proj_1")).rejects.toThrow(/already/i);
		intel.cancel("proj_1");
		finishCleanup?.();
		await expect(pending).rejects.toThrow(/cancel/i);
		expect(await intel.getReport("proj_1")).toBeNull();
		expect(intel.getStatus("proj_1")).toBeNull();
	});
});
