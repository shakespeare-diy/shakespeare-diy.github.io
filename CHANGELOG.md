# Changelog

## [9.11.1] - 2026-04-05

### Changed
- Switch preview pane to iframe.diy for improved reliability and compatibility
- New users start with OpenCode Zen pre-configured for a zero-setup first experience
- Default nsite gateway changed to shakespeare.to with vanity subdomain support
- Update default Blossom servers and relay lists across deployments and uploads

### Fixed
- Default settings no longer override existing users' recently used models
- Showcase card clone URLs now use proper Nostr URI encoding
- Service worker no longer blocks SvelteKit nsite routes

## [9.11.0] - 2026-04-03

### Added
- Upload a banner image for your app directly from the App dialog
- T-tag editor in the App dialog Advanced section for tagging your app by category
- Delete App button in the App dialog Advanced section when editing an existing app
- Ngit repo and nsite deployment address fields in the App dialog Advanced section
- Auto-fill app name, description, and images from your project's OG tags and web manifest on first publish

### Changed
- Redesigned App dialog with an overlapping banner and avatar card layout
- Reorganized App dialog Advanced section into General, Handlers, and Tags tabs
- Showcase cards now show banner and icon images, and require both to appear in the showcase
- Validation summary above the Save button replaces per-field "Required" labels
- Updated showcase curator to the Shakespeare Builders community list

### Fixed
- Upgrade Nostrify to fix bunker connection issues

## [9.10.4] - 2026-04-02

### Fixed
- Fix Android splash screen showing logo masked to white silhouette instead of full color

## [9.10.3] - 2026-04-02

### Fixed
- Fix Android app showing default Capacitor splash screen and icon colors

## [9.10.2] - 2026-04-02

### Fixed
- Fix Android app showing default Capacitor icon instead of Shakespeare logo in app drawer

## [9.10.1] - 2026-04-02

### Fixed
- Replace default Capacitor vector drawable icons with Shakespeare logo

## [9.10.0] - 2026-04-02

### Added
- Android app powered by Capacitor with deep links, splash screen, and signed release builds
- CI pipeline for building APKs, publishing to GitLab releases, and distributing via Zapstore
- Nsite deployment for decentralized hosting via Nostr

### Changed
- Make version number on mobile settings a clickable link to the changelog with build date

## [9.9.2] - 2026-04-02

### Changed
- Simplify nsite deployment to always use named sites, removing the root site option

### Fixed
- Fix crash in "What's new" toast when used outside the router context
- Truncate long changelog excerpts in update notifications so they fit neatly in the toast
- Left-align changelog page content for better readability

## [9.9.1] - 2026-04-02

### Added
- Changelog page and versioning system with "What's new" toast notifications on updates
- Release skill for managing versioned releases with changelog generation and git tagging
