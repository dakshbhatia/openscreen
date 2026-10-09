// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS_POLL_MS, PermissionsWindow } from "./PermissionsWindow";

vi.mock("@/contexts/I18nContext", () => ({
	// Keys come back verbatim, so the assertions read as the contract, not as copy.
	useScopedT: () => (key: string) => key,
}));

type PermissionsApi = Window["electronAPI"]["permissions"];
type Snapshot = Awaited<ReturnType<PermissionsApi["get"]>>;

const FIRST_RUN: Snapshot = {
	supported: true,
	macosMajor: 26,
	screenRequired: true,
	screen: "not-requested",
	screenRequiresRelaunch: false,
	accessibility: "not-requested",
	microphone: "not-requested",
	camera: "not-requested",
	systemAudio: "granted",
};

let current: Snapshot;
let api: { [K in keyof PermissionsApi]: ReturnType<typeof vi.fn> };

beforeEach(() => {
	current = { ...FIRST_RUN };
	api = {
		get: vi.fn(async () => current),
		request: vi.fn(async () => undefined),
		openSettings: vi.fn(async () => undefined),
		relaunch: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
	window.electronAPI = {
		...window.electronAPI,
		permissions: api as unknown as PermissionsApi,
	};
});

afterEach(() => {
	vi.useRealTimers();
});

async function renderWith(snapshot: Partial<Snapshot>) {
	current = { ...FIRST_RUN, ...snapshot };
	render(<PermissionsWindow />);
	await screen.findByTestId("permission-accessibility");
}

describe("PermissionsWindow", () => {
	it("keeps optional onboarding hidden and never requests permission on mount", async () => {
		await renderWith({});
		expect(screen.getByRole("heading", { name: "Screen access" })).toBeVisible();
		expect(screen.getByTestId("permission-screen")).toBeVisible();
		expect(screen.getByTestId("permission-microphone")).not.toBeVisible();
		const more = screen.getByText("More · optional recording permissions");
		expect(more.parentElement).not.toHaveAttribute("open");
		more.parentElement?.setAttribute("open", "");
		expect(screen.getByTestId("permission-microphone")).toBeVisible();
		expect(api.request).not.toHaveBeenCalled();
		expect(api.openSettings).not.toHaveBeenCalled();
	});

	it("keeps failure messages safe and allows retrying a permission request", async () => {
		api.request.mockRejectedValueOnce(new Error("private provider response"));
		await renderWith({});
		fireEvent.click(screen.getByTestId("permission-screen-action"));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not open permission settings. Try again.",
		);
		expect(screen.queryByText("private provider response")).not.toBeInTheDocument();
		fireEvent.click(screen.getByTestId("permission-screen-action"));
		await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
	});

	it("provides a way out when the permission status cannot be read", async () => {
		api.get.mockRejectedValue(new Error("helper unavailable"));
		render(<PermissionsWindow />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not check screen access");
		fireEvent.click(screen.getByTestId("permissions-start"));
		expect(api.close).toHaveBeenCalled();
	});

	it("offers Continue, not Allow, for Screen Recording on a first run", async () => {
		await renderWith({});

		const button = screen.getByTestId("permission-screen-action");
		expect(button).toHaveTextContent("permissions.actions.continue");
		expect(screen.getByTestId("permission-microphone-action")).toHaveTextContent(
			"permissions.actions.allow",
		);
		expect(
			screen.getByText("macOS will ask you to enable ProductIntel in System Settings."),
		).toBeInTheDocument();

		fireEvent.click(button);
		await waitFor(() => expect(api.request).toHaveBeenCalledWith("screen"));
		expect(api.openSettings).not.toHaveBeenCalled();
	});

	it("sends a refused permission to System Settings, with help for a missing entry", async () => {
		await renderWith({ screen: "denied" });

		const button = screen.getByTestId("permission-screen-action");
		expect(button).toHaveTextContent("permissions.actions.openSettings");
		expect(
			screen.getByText("Not listed? Click + and choose ProductIntel in Applications."),
		).toBeInTheDocument();

		fireEvent.click(button);
		await waitFor(() => expect(api.openSettings).toHaveBeenCalledWith("screen"));
		expect(api.request).not.toHaveBeenCalled();
	});

	it("allows returning to research without granting recording permissions", async () => {
		await renderWith({ accessibility: "granted", microphone: "granted", camera: "granted" });

		expect(screen.getByTestId("permissions-start")).toBeEnabled();
		fireEvent.click(screen.getByTestId("permissions-start"));
		expect(api.close).toHaveBeenCalled();
		expect(api.request).not.toHaveBeenCalled();
	});

	it("lets the user start once Screen Recording is granted, whatever the optional ones say", async () => {
		await renderWith({ screen: "granted", camera: "denied" });

		const start = screen.getByTestId("permissions-start");
		expect(start).toBeEnabled();
		fireEvent.click(start);
		expect(api.close).toHaveBeenCalled();
	});

	it("offers the relaunch when the grant is not usable by this process yet", async () => {
		await renderWith({ screen: "granted", screenRequiresRelaunch: true });

		expect(screen.getByTestId("permissions-start")).toBeEnabled();
		expect(
			screen.getByText("Screen access is allowed. Restart ProductIntel before recording."),
		).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("permissions-relaunch"));
		expect(api.relaunch).toHaveBeenCalled();
	});

	it("warns about macOS' recurring confirmation only from macOS 15", async () => {
		await renderWith({ screen: "granted", macosMajor: 15 });
		expect(
			screen.getByText("macOS may ask again before recording. Allow screen access to continue."),
		).toBeInTheDocument();
	});

	it("says nothing about it on macOS 14", async () => {
		await renderWith({ screen: "granted", macosMajor: 14 });
		expect(
			screen.queryByText("macOS may ask again before recording. Allow screen access to continue."),
		).not.toBeInTheDocument();
	});

	it("with Apple's picker, offers system audio as optional and lets the user start", async () => {
		await renderWith({ screenRequired: false, systemAudio: "not-requested" });

		expect(screen.queryByTestId("permission-screen")).not.toBeInTheDocument();
		const row = screen.getByTestId("permission-systemAudio");
		expect(within(row).getByText("permissions.rows.systemAudio.name")).toBeInTheDocument();
		expect(within(row).getByText("permissions.level.optional")).toBeInTheDocument();
		expect(
			within(row).getByText("macOS will ask whether ProductIntel may record system audio."),
		).toBeInTheDocument();
		expect(screen.getByTestId("permissions-start")).toBeEnabled();

		fireEvent.click(screen.getByTestId("permission-systemAudio-action"));
		await waitFor(() => expect(api.request).toHaveBeenCalledWith("systemAudio"));
	});

	it("once system audio was asked, offers only its pane, since the answer cannot be read", async () => {
		await renderWith({ screenRequired: false, systemAudio: "requested" });

		const button = screen.getByTestId("permission-systemAudio-action");
		expect(button).toHaveTextContent("permissions.actions.openSettings");
		expect(
			screen.getByText(
				"If access was denied, enable ProductIntel under System Audio Recording Only in System Settings.",
			),
		).toBeInTheDocument();

		fireEvent.click(button);
		await waitFor(() => expect(api.openSettings).toHaveBeenCalledWith("systemAudio"));
		expect(api.request).not.toHaveBeenCalled();
	});

	it("with Apple's picker, never warns about the bypass alert, which it does not raise", async () => {
		await renderWith({ screenRequired: false, screen: "granted", macosMajor: 26 });
		expect(
			screen.queryByText("macOS may ask again before recording. Allow screen access to continue."),
		).not.toBeInTheDocument();
	});

	it("shows a policy-restricted permission without a button", async () => {
		await renderWith({ microphone: "restricted" });

		const row = screen.getByTestId("permission-microphone");
		expect(within(row).getByText("permissions.status.restricted")).toBeInTheDocument();
		expect(screen.queryByTestId("permission-microphone-action")).not.toBeInTheDocument();
	});

	it("follows a grant made in System Settings without any click", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		await renderWith({ screen: "denied" });
		expect(screen.getByTestId("permission-screen")).toHaveAttribute("data-status", "denied");

		current = { ...current, screen: "granted" };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PERMISSIONS_POLL_MS);
		});

		expect(screen.getByTestId("permission-screen")).toHaveAttribute("data-status", "granted");
		expect(screen.getByTestId("permissions-start")).toBeEnabled();
	});
});
