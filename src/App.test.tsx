// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./native/browserShim", () => ({ installBrowserShims: vi.fn() }));
vi.mock("./lib/customFonts", () => ({ loadAllCustomFonts: vi.fn(async () => undefined) }));
vi.mock("./lib/textFonts", () => ({ registerTextFontFaces: vi.fn() }));
vi.mock("./components/ai-edition/AiEditionShell", () => ({
	default: () => <div>Research workspace</div>,
}));
vi.mock("./components/launch/LaunchWindow", () => ({
	LaunchWindow: () => <div>Recording controls</div>,
}));
vi.mock("./components/launch/CountdownOverlay", () => ({ CountdownOverlay: () => null }));
vi.mock("./components/launch/NotesWindow", () => ({ NotesWindow: () => null }));
vi.mock("./components/launch/SourceSelector", () => ({
	SourceSelector: () => <div>Recording source picker</div>,
}));
vi.mock("./components/permissions/PermissionsWindow", () => ({
	PermissionsWindow: () => <div>Screen access</div>,
}));
vi.mock("./components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("./components/ui/tooltip", () => ({
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./contexts/EditorDialogsContext", () => ({
	EditorDialogsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./contexts/ShortcutsContext", () => ({
	ShortcutsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/video-editor/ShortcutsConfigDialog", () => ({
	ShortcutsConfigDialog: () => null,
}));
vi.mock("./components/ai-edition/ProviderSettings", () => ({ ProviderSettingsDialog: () => null }));

afterEach(() => {
	cleanup();
	window.history.replaceState({}, "", "/");
});

describe("ProductIntel window routing", () => {
	it.each([
		"",
		"?windowType=unknown",
		"?windowType=editor",
	])("opens research without legacy onboarding for %s", async (query) => {
		window.history.replaceState({}, "", `/${query}`);
		render(<App />);
		expect(await screen.findByText("Research workspace")).toBeInTheDocument();
		expect(screen.queryByText("Screen access")).not.toBeInTheDocument();
		expect(screen.queryByText("Recording controls")).not.toBeInTheDocument();
		expect(screen.queryByText("Openscreen")).not.toBeInTheDocument();
	});

	it.each([
		["hud-overlay", "Recording controls"],
		["source-selector", "Recording source picker"],
		["permissions", "Screen access"],
	])("keeps the explicit %s route usable", async (windowType, content) => {
		window.history.replaceState({}, "", `/?windowType=${windowType}`);
		render(<App />);
		expect(await screen.findByText(content)).toBeInTheDocument();
		expect(screen.queryByText("Research workspace")).not.toBeInTheDocument();
	});
});
