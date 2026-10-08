// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutAsset } from "@/lib/ai-edition/schema";

const panel = vi.hoisted(() => vi.fn());
const screenshots = vi.hoisted(() => vi.fn());
vi.mock("./ProductIntelPanel", () => ({
	ProductIntelPanel: (props: unknown) => {
		panel(props);
		return <div data-testid="intel-panel" />;
	},
}));
vi.mock("./ScreenshotBoard", () => ({
	ScreenshotBoard: (props: unknown) => {
		screenshots(props);
		return <div data-testid="screenshot-board" />;
	},
}));

import { ResearchWorkspace } from "./ResearchWorkspace";

const asset: AxcutAsset = {
	id: "recording-1",
	label: "Competitor onboarding.mp4",
	originalPath: "/recordings/competitor.mp4",
	durationSec: 95,
	kind: "video",
	cameraTrack: null,
};

function setup(overrides: Partial<React.ComponentProps<typeof ResearchWorkspace>> = {}) {
	const props = {
		active: true,
		projectId: "project-1",
		projectTitle: "Competitor onboarding",
		freshRecordingProjectId: null,
		asset: null,
		sourceReady: false,
		importing: false,
		onRecord: vi.fn(),
		onImport: vi.fn(),
		onLoadedMetadata: vi.fn(),
		...overrides,
	};
	return { ...render(<ResearchWorkspace {...props} />), props };
}

const selectRecording = () => fireEvent.click(screen.getByRole("tab", { name: "Recording" }));

beforeEach(() => {
	panel.mockClear();
	screenshots.mockClear();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
		// jsdom does not decode or play video.
	});
});

describe("ResearchWorkspace", () => {
	it("defaults to screenshots with recording controls hidden", () => {
		setup();
		expect(screen.getByRole("tab", { name: "Screenshots" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tabpanel", { name: "Screenshots" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Import recording" })).not.toBeInTheDocument();
		expect(screen.queryByRole("heading")).not.toBeInTheDocument();
		expect(screenshots).toHaveBeenLastCalledWith({ active: true });
		expect(panel).toHaveBeenLastCalledWith(
			expect.objectContaining({ embedded: true, open: false }),
		);
	});

	it("reveals recording actions without removing the screenshot board", () => {
		const { props } = setup();
		const board = screen.getByTestId("screenshot-board");
		selectRecording();
		fireEvent.click(screen.getByRole("button", { name: "Record flow" }));
		fireEvent.click(screen.getByRole("button", { name: "Import recording" }));
		expect(props.onRecord).toHaveBeenCalledOnce();
		expect(props.onImport).toHaveBeenCalledOnce();
		expect(screen.getByTestId("screenshot-board")).toBe(board);
		expect(screenshots).toHaveBeenLastCalledWith({ active: false });
		expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
	});

	it("probes recording metadata while screenshot mode is selected", () => {
		const { container, props, rerender } = setup({ asset });
		const video = container.querySelector("video");
		if (!video) throw new Error("Missing source video");
		expect(video).toHaveAttribute("preload", "metadata");
		Object.defineProperty(video, "duration", { value: 95 });
		fireEvent.loadedMetadata(video);
		expect(props.onLoadedMetadata).toHaveBeenCalledWith(95, asset.id);
		expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({ source: null }));
		rerender(<ResearchWorkspace {...props} sourceReady />);
		selectRecording();
		expect(screen.getByText("1:35")).toBeInTheDocument();
		expect(panel).toHaveBeenLastCalledWith(
			expect.objectContaining({
				source: { assetId: asset.id, path: asset.originalPath, durationSec: 95 },
			}),
		);
	});

	it("opens Recording for a fresh take without overriding subsequent tab choices", () => {
		const { props, rerender } = setup({ freshRecordingProjectId: "project-1" });
		expect(screen.getByRole("tab", { name: "Recording" })).toHaveAttribute("aria-selected", "true");
		fireEvent.click(screen.getByRole("tab", { name: "Screenshots" }));
		rerender(<ResearchWorkspace {...props} sourceReady />);
		expect(screen.getByRole("tab", { name: "Screenshots" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		rerender(
			<ResearchWorkspace {...props} projectId="project-2" freshRecordingProjectId="project-2" />,
		);
		expect(screen.getByRole("tab", { name: "Recording" })).toHaveAttribute("aria-selected", "true");
	});

	it("retains the recording analysis component when changing input and editor mode", () => {
		const { props, rerender } = setup({ asset, sourceReady: true });
		selectRecording();
		const analysis = screen.getByTestId("intel-panel");
		fireEvent.click(screen.getByRole("tab", { name: "Screenshots" }));
		expect(screen.getByTestId("intel-panel")).toBe(analysis);
		expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
		rerender(<ResearchWorkspace {...props} active={false} />);
		expect(screen.getByTestId("intel-panel")).toBe(analysis);
		expect(screen.queryByRole("main")).not.toBeInTheDocument();
		expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
		expect(screenshots).toHaveBeenLastCalledWith({ active: false });
	});

	it("reports unreadable recordings only in Recording and clears the error for a different source", () => {
		const { container, props, rerender } = setup({ asset });
		const video = container.querySelector("video");
		if (!video) throw new Error("Missing source video");
		fireEvent.error(video);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		selectRecording();
		expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
		rerender(<ResearchWorkspace {...props} asset={{ ...asset, id: "recording-2" }} />);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("supports keyboard navigation between input tabs", () => {
		setup();
		const screenshotTab = screen.getByRole("tab", { name: "Screenshots" });
		fireEvent.keyDown(screenshotTab, { key: "ArrowRight" });
		expect(screen.getByRole("tab", { name: "Recording" })).toHaveFocus();
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Home" });
		expect(screenshotTab).toHaveFocus();
		expect(screenshotTab).toHaveAttribute("aria-selected", "true");
	});

	it("prevents competing capture actions while importing", () => {
		setup({ importing: true });
		selectRecording();
		expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Record flow" })).toBeDisabled();
	});
});
