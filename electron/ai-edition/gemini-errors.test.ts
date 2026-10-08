import { describe, expect, it } from "vitest";
import { geminiHttpError } from "./gemini-errors";

describe("Gemini HTTP errors", () => {
	it.each([
		[401, /replace the saved key/i],
		[403, /Google project.*selected model/i],
		[429, /wait and retry.*quota and billing/i],
		[404, /choose an available model/i],
		[500, /temporarily unavailable.*retry/i],
		[503, /temporarily unavailable.*retry/i],
		[599, /temporarily unavailable.*retry/i],
		[418, /request failed.*check your key, model/i],
	] as const)("gives an actionable safe message for HTTP %s", (status, action) => {
		const error = geminiHttpError(status, "screenshots");
		expect(error.message).toMatch(action);
		expect(error.message).toContain(`HTTP ${status}`);
	});
	it("suggests input-specific recovery for bad requests", () => {
		expect(geminiHttpError(400, "screenshots").message).toMatch(/fewer or smaller screenshots/);
		expect(geminiHttpError(400, "recording").message).toMatch(/shorter recording/);
	});
});
