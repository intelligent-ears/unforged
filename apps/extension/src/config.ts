// Fixed settings of the extension (extension.md "Background: sync").

/** The curator whose policies the extension follows. Reads are always scoped to this address. */
export const CURATOR_ADDRESS = "0x9373547bD5171EA42f2A63ED27E631FDCDc43E93";

export const SYNC_PERIOD_MINUTES = 10;

/** "Sync now" from the popup runs at most this often. */
export const MANUAL_SYNC_GAP_MS = 30_000;
