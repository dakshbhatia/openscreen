import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTEL_SETTINGS } from "../../src/lib/product-intel";
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
		expect(requests.at(-1)?.init?.method).toBe("DELETE");
		expect(JSON.stringify(report)).not.toContain("test-key");
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
