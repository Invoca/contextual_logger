# frozen_string_literal: true

require 'spec_helper'
require 'logger'
require 'active_support/tagged_logging'
require 'contextual_logger'
require 'contextual_logger/overrides/active_support/tagged_logging/formatter'

describe 'ContextualLogger::Overrides::ActiveSupport::TaggedLogging::Formatter' do
  before do
    Time.now_override = Time.now
    @logger = Logger.new('/dev/null').extend(ContextualLogger::LoggerMixin)
    @logger.formatter = ->(_, _, _, msg_with_context) { "#{msg_with_context.to_json}\n" }
    @logger = ActiveSupport::TaggedLogging.new(@logger)
  end

  it 'should log log_tags as additional context' do
    @logger.push_tags('test')
    expected_log_line = {
      message: 'this is a test',
      severity: 'DEBUG',
      timestamp: Time.now,
      service: 'test_service',
      log_tags: 'test'
    }.to_json

    expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
    expect(@logger.debug('this is a test', service: 'test_service')).to eq(true)
  end
end
