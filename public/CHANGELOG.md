# Changelog

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
