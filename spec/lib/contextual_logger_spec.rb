# frozen_string_literal: true

require 'spec_helper'
require 'logger'
require 'contextual_logger'

describe 'ContextualLogging' do
  before do
    Time.now_override = Time.now
    @logger = ContextualLogger.new(Logger.new('/dev/null'))
  end

  it 'should respond to with_context' do
    expect(@logger).to respond_to(:with_context)
  end

  it 'should allow context be passed into info' do
    expected_log_line = {
      service: 'test_service',
      message: 'this is a test',
      severity: 'INFO',
      timestamp: Time.now,
      progname: nil,
    }.to_json

    expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
    expect(@logger.info('this is a test', service: 'test_service')).to eq(true)
  end
end
