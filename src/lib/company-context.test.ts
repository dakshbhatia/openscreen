import { describe, expect, it } from "vitest";
import {
	companyContextSchema,
	companyDomainSchema,
	normalizeCompanyDomain,
	parseCompanyContext,
} from "./company-context";

const success = (retrievedUrl = "https://example.com/") => ({
	retrievedUrl,
	urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
});

describe("optional public company domain", () => {
	it.each([
		["", ""],
		["  ", ""],
		["example.com", "https://example.com"],
		[" https://EXAMPLE.com/about/team ", "https://example.com"],
		["www.example.com/product", "https://www.example.com"],
		["https://example.com:443/about", "https://example.com"],
		["https://example.com./about", "https://example.com"],
		["https://bücher.de/about", "https://xn--bcher-kva.de"],
	])("normalizes %j to %j without fetching", (input, expected) => {
		expect(normalizeCompanyDomain(input)).toBe(expected);
		expect(companyDomainSchema.parse(input)).toBe(expected);
	});
	it.each([
		"http://example.com",
		"ftp://example.com",
		"file:///etc/passwd",
		"//example.com",
		"company",
		"https://user:password@example.com",
		"https://user@example.com",
		"https://@example.com",
		"example.com?token=private",
		"https://example.com/path#private",
		"https://example.com?",
		"https://example.com#",
		"https://example.com:8443",
		"https://exa\nmple.com",
		"https://example.com\\@localhost",
		"localhost",
		"localhost.localdomain",
		"company.local",
		"company.internal",
		"company.test",
		"https://127.0.0.1",
		"https://127.1",
		"https://2130706433",
		"https://0x7f000001",
		"https://10.1.2.3",
		"https://192.168.1.2",
		"https://172.16.0.1",
		"https://169.254.169.254",
		"https://8.8.8.8",
		"https://[::1]",
		"https://[2001:4860:4860::8888]",
		"https://-bad.example.com",
	])("rejects unsafe or non-public input %j", (input) => {
		expect(() => normalizeCompanyDomain(input)).toThrow(/public company domain/i);
		expect(companyDomainSchema.safeParse(input).success).toBe(false);
	});
});

describe("provider-confirmed company context", () => {
	it("accepts only successful provider URLs for the company host, with www equivalence", () => {
		const context = parseCompanyContext("example.com/about", {
			urlMetadata: [
				success(),
				success("https://www.example.com/product"),
				success(),
				success("https://other.com/"),
			],
		});
		expect(context).toEqual({
			domain: "https://example.com",
			status: "retrieved",
			sourceUrls: ["https://example.com/", "https://www.example.com/product"],
		});
		expect(companyContextSchema.parse(context)).toEqual(context);
		expect(parseCompanyContext("www.example.com", { urlMetadata: [success()] }).status).toBe(
			"retrieved",
		);
	});
	it.each([
		undefined,
		null,
		{},
		{ urlMetadata: [] },
		{
			urlMetadata: [
				{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" },
			],
		},
		{ urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "SUCCESS" }] },
		{ urlMetadata: [success("https://other.com/")] },
		{ urlMetadata: [success("https://blog.example.com/")] },
		{ urlMetadata: [success("http://example.com/")] },
		{ urlMetadata: [success("https://user@example.com/")] },
		{ urlMetadata: [success("https://example.com/?token=private")] },
		{
			summary: "I visited example.com and learned about the company.",
			status: "retrieved",
			sourceUrls: ["https://example.com/"],
		},
	])("keeps retrieval unavailable for failed, unrelated, unsafe or absent metadata", (metadata) => {
		expect(parseCompanyContext("example.com", metadata)).toEqual({
			domain: "https://example.com",
			status: "unavailable",
			sourceUrls: [],
		});
	});
	it("keeps a missing company domain unavailable even if provider metadata exists", () => {
		expect(parseCompanyContext("", { urlMetadata: [success()] })).toEqual({
			domain: "",
			status: "unavailable",
			sourceUrls: [],
		});
	});
	it("rejects inconsistent, non-public, unrelated or extra saved metadata", () => {
		const valid = {
			domain: "https://example.com",
			status: "retrieved",
			sourceUrls: ["https://example.com/about"],
		};
		for (const value of [
			{ ...valid, sourceUrls: [] },
			{ ...valid, domain: "" },
			{ ...valid, status: "unavailable" },
			{ ...valid, apiKey: "private" },
			{ ...valid, sourceUrls: ["https://other.com/"] },
			{ ...valid, sourceUrls: ["https://127.0.0.1/"] },
			{ ...valid, sourceUrls: ["http://example.com/"] },
			{ ...valid, sourceUrls: ["https://user:password@example.com/"] },
		])
			expect(companyContextSchema.safeParse(value).success).toBe(false);
	});
});
