// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { type AxcutAsset, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory } from "@/lib/ai-edition/store/undoStack";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { nativeBridgeClient } from "@/native/client";
import type { ResearchWorkspace } from "./ResearchWorkspace";

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: async () => true,
		}),
	};
});
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));
// Keep the shell/store transitions real. The workspace's own tests cover its input tabs;
// this boundary exposes the fresh project and source handed to the recording research flow.
vi.mock("./ResearchWorkspace", () => ({
	ResearchWorkspace: (props: ComponentProps<typeof ResearchWorkspace>) => (
		<div hidden={!props.active} data-testid="research-workspace">
			<button type="button" onClick={props.onRecord}>
				Record flow
			</button>
			<button type="button" onClick={props.onImport}>
				Import recording
			</button>
			<output
				data-testid="research-source"
				data-project={props.projectId ?? ""}
				data-fresh={props.freshRecordingProjectId ?? ""}
				data-asset={props.asset?.id ?? ""}
				data-ready={String(props.sourceReady)}
			/>
		</div>
	),
}));

import { NewEditorShell } from "./NewEditorShell";

const originalActions = {
	createProject: useProjectStore.getState().createProject,
	addAsset: useProjectStore.getState().addAsset,
};
const startNewRecording = vi.fn(async () => undefined);
const openVideoFilePicker = vi.fn(async () => ({
	success: true,
	path: "/tmp/competitor-flow.mp4",
	name: "Competitor flow.mp4",
}));
let menuNew: (() => void) | undefined;
let menuOpen: (() => void) | undefined;

function renderShell() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	clearHistory();
	useChatPromptBus.setState({ pending: null });
	useProjectStore.getState().clear();
	vi.spyOn(nativeBridgeClient.aiEdition, "listProjects").mockResolvedValue([]);
	menuNew = undefined;
	menuOpen = undefined;
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => vi.fn(),
		getPlatform: () => "darwin",
		setTitleBarOverlay: vi.fn(),
		setHasUnsavedChanges: vi.fn(),
		onRequestCloseConfirm: () => vi.fn(),
		onRequestSaveBeforeClose: () => vi.fn(),
		sendCloseConfirmResponse: vi.fn(),
		findRecordingCamera: async () => null,
		preparePreviewAudioTrack: async () => null,
		startNewRecording,
		openVideoFilePicker,
		onMenuNewProject: (callback: () => void) => {
			menuNew = callback;
			return vi.fn();
		},
		onMenuLoadProject: (callback: () => void) => {
			menuOpen = callback;
			return vi.fn();
		},
	};
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				/* No layout in jsdom. */
			}
			unobserve() {
				/* No layout in jsdom. */
			}
			disconnect() {
				/* No layout in jsdom. */
			}
		},
	);
	Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
	cleanup();
	useChatPromptBus.setState({ pending: null });
	useProjectStore.setState(originalActions);
	useProjectStore.getState().clear();
	clearHistory();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

function seedUnsavedProject() {
	const document = createEmptyDocument({ projectId: "proj_unsaved", title: "Current research" });
	useProjectStore.setState({
		document,
		projectId: document.project.id,
		dirty: true,
		status: "ready",
	});
	return document;
}

async function cancelUnsaved() {
	await screen.findByText("dialogs.unsavedChanges.modal.notSavedYet");
	fireEvent.click(screen.getByRole("button", { name: "common.actions.cancel" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("research capture shell integration", () => {
	it("keeps deferred editor prompts from revealing the studio in research or capture", async () => {
		useChatPromptBus.getState().submit("An old editor request");
		renderShell();
		expect(screen.getByTestId("research-workspace")).toBeVisible();
		expect(
			screen.queryByRole("complementary", { name: "editor.shell.aiEditor" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Record flow" }));
		await act(async () => useChatPromptBus.getState().submit("Another editor request"));
		expect(screen.getByRole("button", { name: "editor.rec.startRecording" })).toBeVisible();
		expect(
			screen.queryByRole("complementary", { name: "editor.shell.aiEditor" }),
		).not.toBeInTheDocument();
		expect(startNewRecording).not.toHaveBeenCalled();
	});

	it("leaves playback and hidden timeline unchanged when editor hotkeys are pressed in compact capture", async () => {
		const document = seedUnsavedProject();
		const save = vi.spyOn(nativeBridgeClient.aiEdition, "save");
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "Record flow" }));
		expect(screen.getByRole("button", { name: "editor.rec.startRecording" })).toBeVisible();
		await act(async () => {
			for (const key of [" ", "Delete", "Backspace", "z", "t", "a"]) {
				// An editor handler consumes these events before acting. Capture setup must
				// leave them alone even when no media element or selected region is mounted.
				expect(fireEvent.keyDown(window.document.body, { key, cancelable: true })).toBe(true);
			}
		});
		expect(useProjectStore.getState().document).toBe(document);
		expect(useProjectStore.getState().playing).toBe(false);
		expect(save).not.toHaveBeenCalled();
		expect(play).not.toHaveBeenCalled();
		expect(startNewRecording).not.toHaveBeenCalled();
	});

	it("opens compact recording setup without editor chrome and starts exactly once after Discard", async () => {
		seedUnsavedProject();
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "Record flow" }));
		expect(
			screen.getByText("Recording options", { selector: "summary" }).parentElement,
		).not.toHaveAttribute("open");
		expect(
			screen.queryByRole("button", { name: "editor.topbar.toggleChatPanel" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("separator", { name: "editor.shell.resizeTimeline" }),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("research-workspace")).not.toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "editor.rec.startRecording" }));
		await screen.findByText("dialogs.unsavedChanges.modal.recordTitle");
		expect(startNewRecording).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.unsavedChanges.modal.discard" }));
		await waitFor(() => expect(startNewRecording).toHaveBeenCalledOnce());
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("creates a project for an imported recording and hands its source and fresh marker to research", async () => {
		const created = createEmptyDocument({ projectId: "proj_imported", title: "Competitor flow" });
		const asset: AxcutAsset = {
			id: "asset_imported",
			kind: "video",
			label: "Competitor flow.mp4",
			originalPath: "/tmp/competitor-flow.mp4",
			durationSec: 14,
			cameraTrack: null,
		};
		const createProject = vi.fn(async () => {
			useProjectStore.setState({
				document: created,
				projectId: created.project.id,
				status: "ready",
			});
			return created;
		});
		const addAsset = vi.fn(async () => {
			useProjectStore.setState({
				document: {
					...created,
					project: { ...created.project, primaryAssetId: asset.id },
					assets: [asset],
				},
			});
			return asset;
		});
		useProjectStore.setState({ createProject, addAsset });
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "Import recording" }));
		await waitFor(() =>
			expect(screen.getByTestId("research-source")).toHaveAttribute(
				"data-fresh",
				created.project.id,
			),
		);
		expect(openVideoFilePicker).toHaveBeenCalledOnce();
		expect(createProject).toHaveBeenCalledExactlyOnceWith("Competitor flow");
		expect(addAsset).toHaveBeenCalledExactlyOnceWith(
			"/tmp/competitor-flow.mp4",
			"Competitor flow.mp4",
		);
		expect(screen.getByTestId("research-workspace")).toBeVisible();
		expect(screen.getByTestId("research-source")).toHaveAttribute(
			"data-project",
			created.project.id,
		);
		expect(screen.getByTestId("research-source")).toHaveAttribute("data-asset", asset.id);
		expect(screen.getByTestId("research-source")).toHaveAttribute("data-ready", "true");
		expect(startNewRecording).not.toHaveBeenCalled();
	});

	it("keeps the unsaved project after cancelling mouse and native New/Open requests", async () => {
		const document = seedUnsavedProject();
		renderShell();
		for (const nativeAction of [() => menuNew?.(), () => menuOpen?.()]) {
			await act(async () => nativeAction());
			await cancelUnsaved();
			expect(useProjectStore.getState().document).toBe(document);
		}
		fireEvent.click(screen.getByLabelText("More app controls"));
		for (const action of ["newProject", "openProject"]) {
			fireEvent.click(screen.getByRole("button", { name: "App settings" }));
			fireEvent.click(screen.getByRole("menuitem", { name: `editor.topbar.${action}` }));
			await cancelUnsaved();
			expect(useProjectStore.getState().document).toBe(document);
		}
		expect(useProjectStore.getState().dirty).toBe(true);
		expect(startNewRecording).not.toHaveBeenCalled();
		expect(openVideoFilePicker).not.toHaveBeenCalled();
	});
});
