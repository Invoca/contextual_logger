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

  describe 'debug' do
    it 'should allow context be passed into info' do
      expected_log_line = {
        service: 'test_service',
        message: 'this is a test',
        severity: 'DEBUG',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
      expect(@logger.debug('this is a test', service: 'test_service')).to eq(true)
    end
  end

  describe 'info' do
    it 'should allow context be passed into info' do
      expected_log_line = {
        service: 'test_service',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
      expect(@logger.info('this is a test', service: 'test_service')).to eq(true)
    end
  end

  describe 'warn' do
    it 'should allow context be passed into info' do
      expected_log_line = {
        service: 'test_service',
        message: 'this is a test',
        severity: 'WARN',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
      expect(@logger.warn('this is a test', service: 'test_service')).to eq(true)
    end
  end

  describe 'error' do
    it 'should allow context be passed into info' do
      expected_log_line = {
        service: 'test_service',
        message: 'this is a test',
        severity: 'ERROR',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
      expect(@logger.error('this is a test', service: 'test_service')).to eq(true)
    end
  end

  describe 'fatal' do
    it 'should allow context be passed into info' do
      expected_log_line = {
        service: 'test_service',
        message: 'this is a test',
        severity: 'FATAL',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")
      expect(@logger.fatal('this is a test', service: 'test_service')).to eq(true)
    end
  end
end
