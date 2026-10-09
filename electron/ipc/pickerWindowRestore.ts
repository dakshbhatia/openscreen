interface PickerWindow {
	isDestroyed(): boolean;
	isVisible(): boolean;
	hide(): void;
	show(): void;
	showInactive(): void;
	focus(): void;
	webContents: { getURL(): string };
}

/** Restore the same caller after the native picker, without activating a recording HUD. */
export async function presentPickerForWindow<T>(
	window: PickerWindow | null,
	present: () => Promise<T>,
): Promise<T> {
	const hiddenWindow = window && !window.isDestroyed() && window.isVisible() ? window : null;
	hiddenWindow?.hide();
	try {
		return await present();
	} finally {
		if (hiddenWindow && !hiddenWindow.isDestroyed()) {
			let isEditor = false;
			try {
				isEditor =
					new URL(hiddenWindow.webContents.getURL()).searchParams.get("windowType") === "editor";
			} catch {
				// An unknown window keeps the HUD's nonactivating restore behavior.
			}
			if (!hiddenWindow.isDestroyed()) {
				if (isEditor) {
					hiddenWindow.show();
					if (!hiddenWindow.isDestroyed()) hiddenWindow.focus();
				} else {
					hiddenWindow.showInactive();
				}
			}
		}
	}
}
