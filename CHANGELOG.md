# CHANGELOG for `contextual_logger`

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Note: this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - Unreleased
### Added
- The ability to redact sensitive data from log entries by registering the sensitive strings ahead of time with the logger

## [0.5.1] - 2020-03-10
### Changed
- Fixed Rails Server logging to STDOUT: Refactored debug, info, error... etc methods to call the base class `add(severity, message, progrname)` method since
  `ActiveSupport::Logger.broadcast` reimplements that to broadcast to multiple logger instances, such as
  `Rails::Server` logging to `STDOUT` + `development.log`.
  Note that the base class `add()` does not have a `context` hash like our `add()` does.
  We use the `**` splat to match the `context` hash up to the extra
  `**context` argument, if present. If that argument is not present (such as with `broadcast`), Ruby will instead
  match the `**context` up to the `progname` argument.

## [0.5.0] - 2020-03-06
### Added
 - Extracted `ContextualLogger.normalize_log_level` into a public class method so we can call it elsewhere where we allow log_level to be
   configured to text values like 'debug'.

[0.6.0]: https://github.com/Invoca/contextual_logger/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Invoca/contextual_logger/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Invoca/contextual_logger/compare/v0.4.0...v0.5.0
