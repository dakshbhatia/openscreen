/** Provider bodies can contain request data; only use HTTP status for user-facing errors. */
export function geminiHttpError(status: number, source: "screenshots" | "recording"): Error {
	let action: string;
	switch (status) {
		case 401:
			action =
				"The Gemini API key was rejected. Replace the saved key in More or Research settings, then retry.";
			break;
		case 403:
			action =
				"Gemini access was denied. Check that this key’s Google project can use the Gemini API and selected model, then retry.";
			break;
		case 429:
			action =
				"Gemini quota or rate limit reached. Wait and retry, or check your Google API quota and billing.";
			break;
		case 404:
			action =
				"Gemini could not find the selected model or uploaded file. Choose an available model in Research settings and analyze again.";
			break;
		case 400:
			action = `Gemini could not accept this request. Check the selected model, then try ${source === "screenshots" ? "fewer or smaller screenshots" : "a shorter recording"} and analyze again.`;
			break;
		default:
			action =
				status >= 500 && status <= 599
					? "Gemini is temporarily unavailable. Wait a moment and retry."
					: "Gemini request failed. Retry; if it continues, check your key, model and Google API quota.";
	}
	return new Error(`${action} (HTTP ${status})`);
}
