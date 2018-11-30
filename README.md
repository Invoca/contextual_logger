# ContextualLogger [![Build Status](https://travis-ci.org/Invoca/contextual_logger.svg?branch=master)](https://travis-ci.org/Invoca/contextual_logger) [![Coverage Status](https://coveralls.io/repos/github/Invoca/contextual_logger/badge.svg?branch=master)](https://coveralls.io/github/Invoca/contextual_logger?branch=master) [![Gem Version](https://badge.fury.io/rb/contextual_logger.svg)](https://badge.fury.io/rb/contextual_logger)
This gem adds the ability to your ruby logger, to accept conditional context, and utilize it when formatting your log entry.

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
To use the contextual logger, all you need to do is initailize the object with your existing logger
```ruby
require 'logger'
require 'contextual_logger'

logger = Logger.new(STDOUT)
contextual_logger = ContextualLogger.new(logger)
```

### Logging
All base logging methods are available for use with _or_ without added context
```ruby
contextual_logger.info('Something might have just happened', file: __FILE__, current_object: inspect)
```

If there is a base set of context you'd like to apply to a block of code, simply wrap it in `#with_context`
```ruby
contextual_logger.with_context(file: __FILE__, current_object: inspect) do
  contextual_logger.info('Something might have just happened')
  try.doing_something()
rescue => ex
  contextual_logger.error('Something definitely just happened', error: ex.message)
end
```

If you'd like to set a global context for your process, you can do the following
```ruby
contextual_logger.global_context = { service_name: 'test_service' }
```

### Overrides
#### ActiveSupport::TaggedLogging
ActiveSupport's TaggedLogging extension adds the ability for tags to be prepended onto logs in an easy to use way.  This is a very
powerful piece of functionality.  If you're using this, there is an override you can use, to pull the tags into the context.
All you need to do is add the following to your application's start up script:
```ruby
require 'contextual_logger/overrides/active_support/tagged_logging/formatter'
```

## Contributions

Contributions to this project are always welcome.  Please thoroughly read our [Contribution Guidelines](https://github.com/Invoca/contextual_logger/blob/master/CONTRIBUTING.md) before starting any work.
