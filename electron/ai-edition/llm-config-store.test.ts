import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
	isEncryptionAvailable: vi.fn(() => true),
	encryptString: vi.fn((value: string) => Buffer.from(value).reverse()),
	decryptString: vi.fn((value: Buffer) => Buffer.from(value).reverse().toString()),
}));
vi.mock("electron", () => ({ safeStorage: storage }));

import { LlmConfigStore } from "./llm-config-store";

let directory: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "intel-key-"));
	storage.isEncryptionAvailable.mockReturnValue(true);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(directory, { recursive: true, force: true });
});

it("persists explicitly imported environment credentials through safeStorage across restarts", async () => {
	vi.stubEnv("GEMINI_API_KEY", "fixture-key-never-plaintext");
	const store = new LlmConfigStore(directory);
	expect(await store.importEnvironmentApiKey("google", ["GEMINI_API_KEY"])).toBe(true);
	const saved = await fs.readFile(path.join(directory, "llm-credentials.enc"));
	expect(saved.toString()).not.toContain("fixture-key-never-plaintext");
	vi.stubEnv("GEMINI_API_KEY", "");
	expect(new LlmConfigStore(directory).getApiKey("google")).toBe("fixture-key-never-plaintext");
});

it("preserves an existing connection and does not create a blob for absent keys", async () => {
	vi.stubEnv("GEMINI_API_KEY", "");
	const store = new LlmConfigStore(directory);
	expect(await store.importEnvironmentApiKey("google", ["GEMINI_API_KEY"])).toBe(false);
	expect(await fs.readdir(directory)).toEqual([]);
	await store.setCredential("google", { kind: "api-key", apiKey: "existing" });
	vi.stubEnv("GEMINI_API_KEY", "replacement");
	expect(await store.importEnvironmentApiKey("google", ["GEMINI_API_KEY"])).toBe(false);
	expect(new LlmConfigStore(directory).getApiKey("google")).toBe("existing");
});

it("refuses to persist plaintext when OS encryption is unavailable", async () => {
	vi.stubEnv("GEMINI_API_KEY", "fixture-secret");
	storage.isEncryptionAvailable.mockReturnValue(false);
	await expect(
		new LlmConfigStore(directory).importEnvironmentApiKey("google", ["GEMINI_API_KEY"]),
	).rejects.toThrow("safeStorage");
	expect(await fs.readdir(directory)).toEqual([]);
});
