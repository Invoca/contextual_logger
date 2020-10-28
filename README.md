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

## Strictly Defining Context

The introduction of dynamic context in logging introduces a couple new problems that
need to be solved. First the strict definition of a structure for the logs so that
unknown bloat is removed, and second the strict definition of data types so that when
the data arrives at the end data store it arrives in the right format for injestion.

This is why this gem has the ability to strictly define the context that is expected by
registering the schema of the logger.

### Basic Example

In this basic example, we are configuring the logger to:

1. Strictly manage the context based on the definitions present
2. **Not** raise exceptions when missing definitions are encountered
3. Expect a basic log context to be applied contining:
    1. A `service_name` string
    2. A `kubernetes` hash containing:
        1. A `namespace` string
        2. A `context` string
        3. A `pod_name` string
  3. A `user` hash containing:
      1. A numerical `id`
      2. An `email` string
      3. A `created_at` date object

```ruby
contextual_logger.register_context do
  # This makes it so that the logger will enforce the shape and formating
  # defined within the Context::Registry, stripping out any context keys
  # that are not defined in the registry, and enforcing formatting rules
  # on all values
  strict true

  # This makes it so that the logger will not raise a MissingDefinitionError
  # when code tries to apply a context key that does not map to a definition
  # in the registry
  raise_on_definition_missing false

  string :service_name

  hash :kubernetes do
    string :namespace
    string :context
    string :pod_name
  end

  hash :user do
    number :id
    string :email
    date   :created_at
  end
end
```

### Production Best Practices

In `production` environments it is best to protect your logging from excess bloat by
setting `strict` to `true`, and `raise_on_definition_missing` to `false` in order
to protect against logging causing unnecessary errors.

```ruby
contextual_logger.register_context do
  strict true
  raise_on_definition_missing false
end
```

### Test and Development Best Practices

When running in `test` and `development` environments it is best to be quickly aware
that context is being erroniously added to the logs by setting both `strict` and
`raise_on_definition_missing` to `true`.

```ruby
contextual_logger.register_context do
  strict true
  raise_on_definition_missing true
end
```

### Available Configurations

| Config | Description | Default |
| ------ | :---------: | ------: |
| `strict` | | `true` |
| `raise_on_definition_missing` | | `true` |

### Available Definitions

| Config    | Description | Default Format |
| --------- | :---------: | :-----: |
| `string`  | The provided key will be formatted and enforced as a String | `:to_s` |
| `number`  | The provided key will be formatted and enforced as a numeric value | `:to_i` |
| `boolean` | The provided key will be formatted and enforced as a boolean value | `->(value) { value ? true : false }` |
| `date`    | The provided key will be formatted and enforced as a date string | `->(value) { value.iso8601(6) }` |
| `hash`    | The provided key will be formatted and enforced as a hash | |

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
