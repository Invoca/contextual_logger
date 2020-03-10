# CHANGELOG for `contextual_logger`

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

Note: this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1.pre.1] - 2019-03-10

### Changed

- Refactored debug, info, error... etc methods to call the base class `add(severity, message, progrname)` method since
  ActiveSupport::Logger.broadcast reimplements that to broadcast to multiple logger instances, such as
  Rails::Server logging to `STDOUT` + `development.log`.
  Note that the base class `add()` does not have a `context` hash like our `add()` does.
  We use the `**` splat to match the `context` hash up to the extra
  `**context` argument, if present. If that argument is not present (such as with `broadcast`), Ruby will instead
  match the `**context` up to the `progname` argument.

## [0.5] - 2019-03-06

### Added
 - Extracted normalize_log_level to a public class method so we can call it elsewhere where we allow log_level to be
   configured to text values like 'debug'.
