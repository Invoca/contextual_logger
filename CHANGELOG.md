# CHANGELOG for `contextual_logger`

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Note: this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2020-09-15
### Changed
- Updated contextual logger to normalize keys to symbols and warn on string keys

## [0.10.0] - 2020-09-02
### Added
- Added support and tests for all combinations of `progname`, `message`, and `context`:
```
logger.info(message)
logger.info(context_key1: value, context_key2: value)
logger.info(message, context_key1: value, context_key2: value)
logger.info { message }
logger.info(progname) { message }
logger.info(context_key1: value, context_key2: value) { message }
logger.info(progname, context_key1: value, context_key2: value) { message }
```
including where `progname` and `message` are types other than `String`.

### Fixed
- Fixed bug where usage like in Faraday: `logger.info(progname) { message }` was dropping the message and only showing
  `progname`.
- Fixed bug in block form where the message block would be called even if the log_level was not enabled
  (this could have been slow).

## [0.9.1] - 2020-08-18
### Fixed
- Fixed bug where merging context with string keys was causing a "key" is not a Symbol error

## [0.9.0] - 2020-08-17
### Removed
- Removed unnecessary duplicate context (`severity`, `timestamp`, and `progname`) in message hash passed to formatter. These
are already passed to the formatter as arguments so that the formatter can decide how to add them to the log line.

## [0.8.0] - 2020-05-15
### Added
- Added support for rails 5 and 6.
- Added appraisal tests for all supported rails version: 4/5/6

### Changed
- Updated various test to be compatible with rails version 4/5/6
- Updated the CI pipeline to test against all three supported versions of rails

### Fixed
- Fixed undefined method `delegate` bug in ActiveSupport version 4

## [0.7.0] - 2020-05-14
### Deprecated
- Deprecated ContextualLogger.new. It will be removed in version 1.0.
  Instead, use `expect ContextualLogger::LoggerMixin` on a logger instance or `include ContextualLogger::LoggerMixin` in a Logger class.

## [0.6.1] - 2020-04-03
### Fixed
- Fixed gemspec to point to correct source code uri

## [0.6.0] - 2020-04-13
### Added
- Added the ability to redact sensitive data from log entries by registering the sensitive strings ahead of time with the logger
- Added `ContextualLogger#normalize_message` as a general logging helper method to normalize any message to string format.

### Changed
- Restored ::Logger's ability to log non-string messages like `nil` or `false`, in case there's a gem
  we use someday that depends on that.

- JSON logging now logs all messages as strings, by calling `normalize_message`, above.
  Previously, messages were converted by `.to_json`, so `nil` was logged as JSON `null`; now it is logged as the string `"nil"`.
  Similarly, `false` was logged as JSON `false`; now it is logged as the string `"false"`.

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

[0.11.0]: https://github.com/Invoca/contextual_logger/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Invoca/contextual_logger/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/Invoca/contextual_logger/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Invoca/contextual_logger/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Invoca/contextual_logger/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Invoca/contextual_logger/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Invoca/contextual_logger/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Invoca/contextual_logger/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Invoca/contextual_logger/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Invoca/contextual_logger/compare/v0.4.0...v0.5.0
