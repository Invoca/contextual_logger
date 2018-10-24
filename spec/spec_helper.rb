# frozen_string_literal: true

require 'simplecov'
require 'simplecov-json'
require 'simplecov-rcov'

SimpleCov.formatters = [
  SimpleCov::Formatter::HTMLFormatter,
  SimpleCov::Formatter::JSONFormatter,
  SimpleCov::Formatter::RcovFormatter
]
SimpleCov.start

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end
  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end
  config.shared_context_metadata_behavior = :apply_to_host_groups
end

class Time
  class << self
    def now_override= override_time
      @@now_override = override_time
    end

    def now_override
      @@now_override ||= nil
    end

    unless defined? @@_old_now_defined
      alias old_now now
      @@_old_now_defined = true
    end
  end

  def self.now
    now_override ? now_override.dup : old_now
  end
end
