# Changelog

All notable changes of the project written down here.

## [3.0.0] - 2026-10-25

### Added

- Upgraded the codebase into 2 versions, v1 for legacy routes and v2 for new ones

## [2.6.0] - 2026-10-18

### Added

- Created a custom decorator for timed middleware (Getting idea about the time taken by a req res cycle)
- Implemented sentry and created observability middleware

## [2.5.1] - 2026-10-17

### Changed

- Simplified the blacklist middleware logic

## [2.5.0] - 2026-10-17

### Added

- Implemented multiple middlewares
- Implemented Request log middleware by creating a new schema for it
- Implemented a middleware for blacklisting the user

## [2.4.1] - 2026-10-08

### Changed

- Refactored the test file of the url

## [2.4.0] - 2026-10-08

### Added

- Implemented adding passwords for updating or deleting short_codes
- Implemented creation and fetch of list of urls specific to a user
- Created an endpoint "/health"

## [2.3.0] - 2026-10-06

### Added

- Implemented few new updates with respect to short_codes.

## [2.2.0] - 2026-10-04

### Added

- Implemented features like adding expiry date and multiple short_codes in batches.
- Created feature of tier, Which can be upgraded from free to enterprise.
- Wrote tests for all features

## [2.1.0] - 2026-10-03

### Added

- Implemented user module
- Implemented new feature of auth using api-key for multiple url operations
- Altered the urls table with expiry_date column.
- Wrote tests for above features

## [2.0.0] - 2026-09-30

### Added

- Created v2
- Implemented Users Schema, Joined with Urls Schema.

## [1.1.0] - 2026-09-28

### Added

- Implemented features like visit_count and last_accessed_at
- Did schema changes
- Removed the unique constraint from original_url
- Built feature of multiple short_codes for single url

## [1.0.1] - 2026-09-22

### Changed

- Fixed module import of the prisma client
- Fixed module imports of generate short_code function

## [1.0.0] - 2026-09-22

### Added

- Created v1
