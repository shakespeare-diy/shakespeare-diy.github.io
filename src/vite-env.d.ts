/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Marketing version from package.json (e.g., "9.9.0"). */
  readonly VERSION: string;
  /** ISO 8601 timestamp of when the app was built (e.g., "2026-04-02T19:42:00.000Z"). */
  readonly BUILD_DATE: string;
  /** Short git commit SHA (e.g., "c1266823"). Empty string if unavailable. */
  readonly COMMIT_SHA: string;
  /** Git tag for the current commit (e.g., "v9.9.0"). Empty string if untagged (pre-release build). */
  readonly COMMIT_TAG: string;
}
