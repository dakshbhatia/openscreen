import { z } from "zod";

const DOMAIN_ERROR =
	"Enter a public company domain or HTTPS homepage without credentials, query parameters, fragments, or a custom port.";
const NONPUBLIC_SUFFIXES = new Set([
	"localhost",
	"local",
	"localdomain",
	"internal",
	"intranet",
	"lan",
	"home",
	"corp",
	"private",
	"test",
	"invalid",
	"example",
	"onion",
]);

function publicUrl(value: string, allowBareDomain: boolean): URL {
	const input = value.trim();
	if (
		!input ||
		input.length > 2048 ||
		/[\\?#]/.test(input) ||
		[...input].some(
			(character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
		) ||
		input.startsWith("/")
	) {
		throw new Error(DOMAIN_ERROR);
	}
	const address = allowBareDomain && !input.includes("://") ? `https://${input}` : input;
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new Error(DOMAIN_ERROR);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		/^https:\/\/[^/]*@/i.test(address) ||
		url.port
	) {
		throw new Error(DOMAIN_ERROR);
	}
	const host = url.hostname.replace(/\.$/, "").toLowerCase();
	const labels = host.split(".");
	if (
		host.length > 253 ||
		labels.length < 2 ||
		labels.every((label) => /^\d+$/.test(label)) ||
		NONPUBLIC_SUFFIXES.has(labels[labels.length - 1]) ||
		labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		throw new Error(DOMAIN_ERROR);
	}
	url.hostname = host;
	return url;
}

/** Normalize optional public company input without fetching or inferring its contents. */
export function normalizeCompanyDomain(value: string): string {
	if (!value.trim()) return "";
	return publicUrl(value, true).origin;
}

export const companyDomainSchema = z
	.string()
	.max(2048)
	.transform((value, context) => {
		try {
			return normalizeCompanyDomain(value);
		} catch {
			context.addIssue({ code: "custom", message: DOMAIN_ERROR });
			return z.NEVER;
		}
	});

const publicSourceUrlSchema = z
	.string()
	.max(2048)
	.transform((value, context) => {
		try {
			return publicUrl(value, false).href;
		} catch {
			context.addIssue({
				code: "custom",
				message:
					"Company sources must be public HTTPS URLs without credentials, query parameters, or fragments.",
			});
			return z.NEVER;
		}
	});
const companyHost = (value: string) => new URL(value).hostname.replace(/^www\./, "");

export const companyContextSchema = z
	.strictObject({
		domain: companyDomainSchema,
		status: z.enum(["retrieved", "unavailable"]),
		sourceUrls: z.array(publicSourceUrlSchema).max(20),
	})
	.superRefine((context, issue) => {
		if (
			(context.status === "retrieved" && (!context.domain || context.sourceUrls.length === 0)) ||
			(context.status === "unavailable" && context.sourceUrls.length > 0)
		) {
			issue.addIssue({
				code: "custom",
				message: "Company retrieval status must match its verified sources.",
			});
		}
		if (
			context.domain &&
			context.sourceUrls.some((source) => companyHost(source) !== companyHost(context.domain))
		) {
			issue.addIssue({
				code: "custom",
				path: ["sourceUrls"],
				message: "Company sources must belong to the supplied company host.",
			});
		}
	});
export type CompanyContext = z.infer<typeof companyContextSchema>;

const urlMetadataSchema = z.object({
	urlMetadata: z
		.array(
			z.object({
				retrievedUrl: z.string(),
				urlRetrievalStatus: z.string(),
			}),
		)
		.max(20),
});

/** Read candidate.urlContextMetadata; model prose cannot confirm website retrieval. */
export function parseCompanyContext(domain: string, raw: unknown): CompanyContext {
	const normalized = normalizeCompanyDomain(domain);
	const unavailable: CompanyContext = { domain: normalized, status: "unavailable", sourceUrls: [] };
	if (!normalized) return unavailable;
	const metadata = urlMetadataSchema.safeParse(raw);
	if (!metadata.success) return unavailable;
	const sourceUrls = new Set<string>();
	for (const entry of metadata.data.urlMetadata) {
		if (entry.urlRetrievalStatus !== "URL_RETRIEVAL_STATUS_SUCCESS") continue;
		const source = publicSourceUrlSchema.safeParse(entry.retrievedUrl);
		if (source.success && companyHost(source.data) === companyHost(normalized))
			sourceUrls.add(source.data);
	}
	return sourceUrls.size
		? { domain: normalized, status: "retrieved", sourceUrls: [...sourceUrls] }
		: unavailable;
}
