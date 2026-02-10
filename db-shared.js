// ESM shared DB constants and openDB helper
export const DB_NAME = "CaptureCastDB";
export const DB_VERSION = 3; // Bump version for proper migration
export const STORE_RECORDINGS = "recordings";
export const STORE_CHUNKS = "chunks";

// openDB intentionally not exported — modules should implement/open as needed
