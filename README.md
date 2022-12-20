# ContextualLogger [![Build Status](https://travis-ci.org/Invoca/contextual_logger.svg?branch=master)](https://travis-ci.org/Invoca/contextual_logger) [![Coverage Status](https://coveralls.io/repos/github/Invoca/contextual_logger/badge.svg?branch=master)](https://coveralls.io/github/Invoca/contextual_logger?branch=master) [![Gem Version](https://badge.fury.io/rb/contextual_logger.svg)](https://badge.fury.io/rb/contextual_logger)
This gem adds the ability to your ruby logger, to accept conditional context, and utilize it when formatting your log entry.

## Dependencies
* Ruby >= 2.6
* ActiveSupport >= 4.2, < 7

## Installation
To install this gem directly on your machine from rubygems, run the following:
```ruby
gem install contextual_logger
```

To install this gem in your bundler project, add the following to your Gemfile:
```ruby
gem 'contextual_logger', '~> 0.1'
```

To use an unreleased version, add it to your Gemfile for Bundler:
```ruby
gem 'contextual_logger', git: 'git://github.com/Invoca/contextual_logger.git'
```

## Usage
### Initialization
To use the contextual logger, all you need to do is `extend` your existing logger instance:
```ruby
require 'logger'
require 'contextual_logger'

contextual_logger = Logger.new(STDOUT)
contextual_logger.extend(ContextualLogger::LoggerMixin)
```
Or, `include` it into your own Logger class:
```ruby
require 'logger'
require 'contextual_logger'

class ApplicationLogger < Logger
  include ContextualLogger::LoggerMixin
  ...
end

contextual_logger = ApplicationLogger.new(STDOUT)
```
## Ways to Set Context
Context may be provided any of 3 ways. Typically, all 3 will be used together.

- Globally for the process
  - For a block or period of time. These may be nested.
    - Inline when logging a message

Indentation above indicates nested precedence. The indented, inner level "inherits" the context
from the enclosing, outer level. If the same key appears at multiple levels,
the innermost level's value will take precedence.

Each of the 3 ways to set context is explained below, starting from the innermost (highest precedence).

### Log Entries With Inline Context
All base logging methods (`debug`, `info`, `warn` etc) are available for use with optional inline context passed as a hash at the end:
```ruby
contextual_logger.info('Service started', configured_options: config.inspect)
```

The block form with optional 'progname' is also supported. As with `::Logger`, the block is only called if the log level is enabled.
```ruby
contextual_logger.debug('progname', current_id: current_object.id) { "debug: #{expensive_debug_function}" }
```
Equally, the `Logger#add` may be passed an optional inline context at the end:
```ruby
contextual_logger.add("INFO", 'progname', 'Service started', configured_options: config.inspect)
```
The block form of `Logger#add` is also supported:
```ruby
contextual_logger.add("DEBUG", 'progname', file: __FILE__, current_object: inspect) { "debug: #{expensive_debug_function}" }
```

### Applying Context Around a Block
If there is a set of context you'd like to apply to a block of code, simply wrap it in `#with_context`.
These may be nested:
```ruby
log_context = { file: __FILE__, current_object: inspect }
contextual_logger.with_context(log_context) do
  contextual_logger.info('Service started')

  invoice_log_context = { invoice_id: invoice.id }
  contextual_logger.with_context(invoice_log_context) do
    contextual_logger.info('About to process invoice')

    process(invoice)
  end
end
```

### Applying Context Across Bracketing Methods
The above block-form is highly recommended, because you can't forget to reset the context.
But sometimes you need to set the context for a period of time across bracketing methods that aren't
set up to use in a block.
You can manage the context reset yourself by not passing a block to `with_context`.
In this case, it returns a `context_handler` object to you on which you must
later call `reset!` to pop that context off the stack.

Consider for example the `Test::Unit`/`minitest` convention of `setup` and `teardown`
methods that are guaranteed to be called before/after tests.
The context could be set in `setup` and reset in `teardown`:
```ruby
def setup
  log_context = { file: __FILE__, current_object: inspect }
  @log_context_handler = logger.with_context(log_context)
end

def teardown
  @log_context_handler&.reset!
end
````

### Setting Process Global Context
If you'd like to set a global context for your process, you can do the following
```ruby
contextual_logger.global_context = { service_name: 'test_service' }
```

## Redaction
### Registering a Secret
In order to register sensitive strings to the logger for redaction to occur, do the following:
```ruby
password = "ffbba9b905c0a549b48f48894ad7aa9b7bd7c06c"
contextual_logger.register_secret(password)

contextual_logger.info("Request sent with body { 'username': 'test_user', 'password': 'ffbba9b905c0a549b48f48894ad7aa9b7bd7c06c' } }")
```
The above will produce the resulting log line:
```
03/10/20 12:22:05.769 INFO Request sent with body { 'username': 'test_user', 'password': '<redacted>' }
```

Regex is also supported for redaction:
```ruby
regex = /(key|password|token|secret)[_a-z]*[\s\"]*(:|=>|=)[\s\"]*\K([0-9a-z_]*)/i
contextual_logger.register_secret_regex(regex)

contextual_logger.info("Request set with body { 'username': 'test_user', 'password': 'ffbba9b905c0a549b48f48894ad7aa9b7bd7c06c' } }")
```
The above will produce the resulting log line:
```
03/10/20 12:22:05.769 INFO Request sent with body { 'username': 'test_user', 'password': '<redacted>' }
```

## Overrides
### ActiveSupport::TaggedLogging
ActiveSupport's `TaggedLogging` extension adds the ability for tags to be prepended onto logs in an easy to use way. This is a very
powerful piece of functionality. If you're using this, there is an override you can use, to pull the tags into the context.
All you need to do is add the following to your application's startup script:
```ruby
require 'contextual_logger/overrides/active_support/tagged_logging/formatter'
```

## Contributions

Contributions to this project are always welcome.  Please thoroughly read our [Contribution Guidelines](https://github.com/Invoca/contextual_logger/blob/master/CONTRIBUTING.md) before starting any work.
