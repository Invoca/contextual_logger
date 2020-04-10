# frozen_string_literal: true

require 'coveralls'
Coveralls.wear!

module Helpers
  def log_at_every_level(logger, context = {})
    logger.debug("debug message", context)
    logger.info("info message", context)
    logger.warn("warn message", context)
    logger.error("error message", context)
    logger.fatal("fatal message", context)
    logger.unknown("unknown message", context)
  end

  def log_message_at_every_level(logger, message, context = {})
    logger.debug(message, context)
    logger.info(message, context)
    logger.warn(message, context)
    logger.error(message, context)
    logger.fatal(message, context)
    logger.unknown(message, context)
  end

  def log_message_levels
    log_stream.string.split("\n").map { |log_line| log_line[/([a-z]+) message/, 1] }
  end
end

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end
  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end
  config.shared_context_metadata_behavior = :apply_to_host_groups

  config.include Helpers
end

class Time
  class << self
    attr_writer :now_override

    def now_override
      @now_override ||= nil
    end

    unless defined? @_old_now_defined
      alias old_now now
      @_old_now_defined = true
    end
  end

  def self.now
    now_override ? now_override.dup : old_now
  end
end
