// Fixed settings of the extension (extension.md "Background: sync").

/** The curator whose policies the extension follows. Reads are always scoped to this address. */
export const CURATOR_ADDRESS = "0x60422cB6937125250f829ed2d06B02AE2679dE09";

export const SYNC_PERIOD_MINUTES = 10;

/** "Sync now" from the popup runs at most this often. */
export const MANUAL_SYNC_GAP_MS = 30_000;
