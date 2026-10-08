// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativePlayback = vi.hoisted(() => vi.fn());
vi.mock("@/native/useNativePlaybackSync", () => ({ useNativePlaybackSync: nativePlayback }));

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
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: vi.fn(),
	}),
	useScopedT: () => (key: string) => key,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { AUDIO_ROW_EXPANSION_PX } from "@/lib/ai-edition/document/audioTracks";
import { createAudioTrack, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	DEFAULT_TIMELINE_HEIGHT_PX,
	MAX_TIMELINE_HEIGHT_PX,
	MIN_TIMELINE_HEIGHT_PX,
	NewEditorShell,
} from "./NewEditorShell";

function renderShell(enterEditor = true) {
	const result = render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
	if (enterEditor) {
		fireEvent.click(result.getByLabelText("More app controls"));
		fireEvent.click(result.getByRole("button", { name: "Full editor" }));
	}
	return result;
}

describe("NewEditorShell timeline height", () => {
	beforeEach(() => {
		localStorage.clear();
		nativePlayback.mockClear();
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			onAiEditionChatEvent: () => () => {
				/* unsubscribe */
			},
			sendAiEditionChatPrompt: () => {
				/* mock */
			},
			setTitleBarOverlay: () => {
				/* noop */
			},
			setHasUnsavedChanges: () => {
				/* noop */
			},
			onRequestCloseConfirm: () => () => {
				/* unsubscribe */
			},
			onRequestSaveBeforeClose: () => () => {
				/* unsubscribe */
			},
			sendCloseConfirmResponse: () => {
				/* noop */
			},
			findRecordingCamera: () => Promise.resolve(null),
			preparePreviewAudioTrack: () => Promise.resolve(null),
			isAppPackaged: () => false,
		};
		Element.prototype.scrollTo = () => {
			/* no scrolling in jsdom */
		};
		(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
			observe() {
				/* noop */
			}
			unobserve() {
				/* noop */
			}
			disconnect() {
				/* noop */
			}
		};
	});

	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("starts in research with editor tools unmounted, and switches both ways", () => {
		const { container } = renderShell(false);
		const root = container.firstElementChild as HTMLElement;
		expect(screen.getByRole("main", { name: "Competitor research" })).toBeInTheDocument();
		expect(root.style.gridTemplateRows).toBe("58px 1fr 0px");
		expect(nativePlayback).not.toHaveBeenCalled();
		expect(container.querySelector('[role="separator"][aria-orientation="horizontal"]')).toBeNull();
		expect(screen.queryByRole("button", { name: "topbar.export" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("More app controls"));
		fireEvent.click(screen.getByRole("button", { name: "Full editor" }));
		expect(nativePlayback).toHaveBeenCalled();
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${DEFAULT_TIMELINE_HEIGHT_PX}px`);
		expect(screen.getByRole("button", { name: "topbar.export" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back to research" }));
		expect(screen.getByRole("main", { name: "Competitor research" })).toBeInTheDocument();
		expect(root.style.gridTemplateRows).toBe("58px 1fr 0px");
	});

	it("imports directly into a dedicated research project without opening the media editor", async () => {
		const originalCreate = useProjectStore.getState().createProject;
		const originalAdd = useProjectStore.getState().addAsset;
		const create = vi.fn().mockResolvedValue(undefined);
		const add = vi.fn().mockResolvedValue({ id: "imported" });
		const picker = vi
			.fn()
			.mockResolvedValue({ success: true, path: "/recordings/flow.mp4", name: "flow.mp4" });
		Object.assign(window.electronAPI ?? {}, { openVideoFilePicker: picker });
		useProjectStore.setState({ createProject: create, addAsset: add, dirty: false });
		try {
			renderShell(false);
			fireEvent.click(screen.getByRole("tab", { name: "Recording" }));
			fireEvent.click(screen.getByRole("button", { name: "Import recording" }));
			await waitFor(() => expect(add).toHaveBeenCalledWith("/recordings/flow.mp4", "flow.mp4"));
			expect(create).toHaveBeenCalledWith("flow");
			expect(screen.getByRole("main", { name: "Competitor research" })).toBeInTheDocument();
			expect(screen.getByRole("tab", { name: "Recording" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
		} finally {
			useProjectStore.setState({ createProject: originalCreate, addAsset: originalAdd });
		}
	});

	it("exports expected constants allowing all lanes to fit without vertical clipping", () => {
		expect(DEFAULT_TIMELINE_HEIGHT_PX).toBe(392);
		expect(MIN_TIMELINE_HEIGHT_PX).toBe(160);
		expect(MAX_TIMELINE_HEIGHT_PX).toBe(560);
	});

	it("uses DEFAULT_TIMELINE_HEIGHT_PX on first opening when localStorage has no saved height", () => {
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		expect(root).not.toBeNull();
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${DEFAULT_TIMELINE_HEIGHT_PX}px`);
	});

	it("migrates legacy cramped 308px default to DEFAULT_TIMELINE_HEIGHT_PX and persists it", () => {
		localStorage.setItem("os-editor-timeline-height", "308");
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${DEFAULT_TIMELINE_HEIGHT_PX}px`);
		expect(localStorage.getItem("os-editor-timeline-height")).toBe(
			String(DEFAULT_TIMELINE_HEIGHT_PX),
		);
		expect(localStorage.getItem("os-editor-timeline-height-migrated")).toBe("true");
	});

	it("migrates intermediate 344px default to DEFAULT_TIMELINE_HEIGHT_PX and persists it", () => {
		localStorage.setItem("os-editor-timeline-height", "344");
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${DEFAULT_TIMELINE_HEIGHT_PX}px`);
		expect(localStorage.getItem("os-editor-timeline-height")).toBe(
			String(DEFAULT_TIMELINE_HEIGHT_PX),
		);
	});

	it("preserves an intentional user choice of 308px after migration has run", () => {
		localStorage.setItem("os-editor-timeline-height-migrated", "true");
		localStorage.setItem("os-editor-timeline-height", "308");
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.gridTemplateRows).toBe("58px 1fr 308px");
	});

	it("respects a custom user preference saved in localStorage within valid bounds", () => {
		localStorage.setItem("os-editor-timeline-height", "450");
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.gridTemplateRows).toBe("58px 1fr 450px");
	});

	it("clamps out-of-bounds custom heights from localStorage at lower and upper bounds", () => {
		localStorage.setItem("os-editor-timeline-height-migrated", "true");
		localStorage.setItem("os-editor-timeline-height", "50");
		const { container: c1 } = renderShell();
		const root1 = c1.firstElementChild as HTMLElement;
		expect(root1.style.gridTemplateRows).toBe(`58px 1fr ${MIN_TIMELINE_HEIGHT_PX}px`);

		cleanup();
		localStorage.setItem("os-editor-timeline-height", "999");
		const { container: c2 } = renderShell();
		const root2 = c2.firstElementChild as HTMLElement;
		expect(root2.style.gridTemplateRows).toBe(`58px 1fr ${MAX_TIMELINE_HEIGHT_PX}px`);
	});

	it("clamps pointer resizing through startTimelineResize to MIN and MAX bounds", () => {
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		const handle = container.querySelector(
			'[role="separator"][aria-orientation="horizontal"]',
		) as HTMLElement;
		expect(handle).not.toBeNull();

		// Drag down significantly (clientY increases): should clamp to MIN_TIMELINE_HEIGHT_PX
		act(() => {
			fireEvent.pointerDown(handle, { clientY: 400 });
			fireEvent.pointerMove(window, { clientY: 1000 });
		});
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${MIN_TIMELINE_HEIGHT_PX}px`);
		act(() => {
			fireEvent.pointerUp(window);
		});
		expect(localStorage.getItem("os-editor-timeline-height")).toBe(String(MIN_TIMELINE_HEIGHT_PX));

		// Drag up significantly (clientY decreases): should clamp to MAX_TIMELINE_HEIGHT_PX
		act(() => {
			fireEvent.pointerDown(handle, { clientY: 400 });
			fireEvent.pointerMove(window, { clientY: -500 });
		});
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${MAX_TIMELINE_HEIGHT_PX}px`);
		act(() => {
			fireEvent.pointerUp(window);
		});
		expect(localStorage.getItem("os-editor-timeline-height")).toBe(String(MAX_TIMELINE_HEIGHT_PX));
	});

	it("dynamically expands height by AUDIO_ROW_EXPANSION_PX when transitioning from 1 to 2 audio lanes and shrinks back", () => {
		const { container } = renderShell();
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${DEFAULT_TIMELINE_HEIGHT_PX}px`);

		// Add voiceover and music tracks (creating 2 audio rows)
		const doc = createEmptyDocument({ projectId: "p", title: "t" });
		doc.audioTracks = [
			createAudioTrack({
				assetId: "a1",
				durationSec: 5,
				timelineStartSec: 0,
				spanSec: 5,
				kind: "voiceover",
			}),
			createAudioTrack({
				assetId: "a2",
				durationSec: 5,
				timelineStartSec: 0,
				spanSec: 5,
				kind: "music",
			}),
		];

		act(() => {
			useProjectStore.setState({ document: doc });
		});

		const expectedExpandedHeight = DEFAULT_TIMELINE_HEIGHT_PX + AUDIO_ROW_EXPANSION_PX;
		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${expectedExpandedHeight}px`);

		// Remove music track (returning to 1 audio row)
		const singleTrackDoc = {
			...doc,
			audioTracks: [doc.audioTracks[0]],
		};

		act(() => {
			useProjectStore.setState({ document: singleTrackDoc });
		});

		expect(root.style.gridTemplateRows).toBe(`58px 1fr ${DEFAULT_TIMELINE_HEIGHT_PX}px`);
	});
});
