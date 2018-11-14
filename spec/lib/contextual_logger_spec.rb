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

  it 'should respond to debug' do
    expect(@logger).to respond_to(:debug)
  end

  it 'should respond to info' do
    expect(@logger).to respond_to(:info)
  end

  it 'should respond to warn' do
    expect(@logger).to respond_to(:warn)
  end

  it 'should respond to error' do
    expect(@logger).to respond_to(:error)
  end

  it 'should respond to fatal' do
    expect(@logger).to respond_to(:fatal)
  end

  describe 'inline context' do
    it 'should print out context passed into debug' do
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

    it 'should print out context passed into info' do
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

    it 'should print out context passed into warn' do
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

    it 'should print out context passed into error' do
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

    it 'should print out context passed into fatal' do
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

  describe 'with_context block' do
    it 'should print out the wrapper context when logging' do
      expected_log_line = {
        service: 'test_service',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")

      @logger.with_context(service: 'test_service') do
        expect(@logger.info('this is a test')).to eq(true)
      end
    end

    it 'should merge inline context into wrapper context when logging' do
      expected_log_line = {
        service: 'test_service',
        file: 'this_file.json',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")

      @logger.with_context(service: 'test_service') do
        expect(@logger.info('this is a test', file: 'this_file.json')).to eq(true)
      end
    end

    it 'should take inline context over wrapper context when logging' do
      expected_log_line = {
        service: 'test_service_2',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")

      @logger.with_context(service: 'test_service') do
        expect(@logger.info('this is a test', service: 'test_service_2')).to eq(true)
      end
    end

    it 'should combine tiered contexts when logging' do
      expected_log_line = {
        service: 'test_service',
        file: 'this_file.json',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }.to_json

      expect_any_instance_of(Logger::LogDevice).to receive(:write).with("#{expected_log_line}\n")

      @logger.with_context(service: 'test_service') do
        @logger.with_context(file: 'this_file.json') do
          expect(@logger.info('this is a test')).to eq(true)
        end
      end
    end
  end
end
