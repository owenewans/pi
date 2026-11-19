import { isAppleTerminalSession } from "@earendil-works/pi-tui";

/**
 * The pi logo: 4 cells wide and 2 lines tall, rendered in the terminal's default foreground color.
 */
export function piLogoLines(): [string, string] {
	return ["█▀█ ", "█▀ █"];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "Pi" in the terminal's default foreground color. */
export function piWordmark(): string {
	return "Pi";
}
