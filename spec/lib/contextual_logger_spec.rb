# frozen_string_literal: true

require 'spec_helper'
require 'logger'
require 'contextual_logger'
require 'json'

def expect_log_line_to_be_written(log_line)
  expect_any_instance_of(Logger::LogDevice).to receive(:write).with(a_json_log_line_like("#{log_line}\n"))
end

RSpec::Matchers.define :a_json_log_line_like do |expected|
  match { |actual| JSON.parse(actual) == JSON.parse(expected) }
end

describe 'ContextualLogging' do
  before(:each) { Time.now_override = Time.now }
  after(:each)  { logger.global_context = {} }

  subject(:logger) { ContextualLogger.new(Logger.new('/dev/null')) }

  it { is_expected.to respond_to(:with_context) }
  it { is_expected.to respond_to(:debug) }
  it { is_expected.to respond_to(:info) }
  it { is_expected.to respond_to(:warn) }
  it { is_expected.to respond_to(:error) }
  it { is_expected.to respond_to(:fatal) }

  describe 'inline context' do
    let(:expected_log_hash) do
      {
        service: 'test_service',
        message: 'this is a test',
        timestamp: Time.now,
        progname: nil
      }
    end

    it 'prints out context passed into debug' do
      expect_log_line_to_be_written(expected_log_hash.merge(severity: 'DEBUG').to_json)
      expect(logger.debug('this is a test', service: 'test_service')).to eq(true)
    end

    it 'prints out context passed into info' do
      expect_log_line_to_be_written(expected_log_hash.merge(severity: 'INFO').to_json)
      expect(logger.info('this is a test', service: 'test_service')).to eq(true)
    end

    it 'prints out context passed into warn' do
      expect_log_line_to_be_written(expected_log_hash.merge(severity: 'WARN').to_json)
      expect(logger.warn('this is a test', service: 'test_service')).to eq(true)
    end

    it 'prints out context passed into error' do
      expect_log_line_to_be_written(expected_log_hash.merge(severity: 'ERROR').to_json)
      expect(logger.error('this is a test', service: 'test_service')).to eq(true)
    end

    it 'prints out context passed into fatal' do
      expect_log_line_to_be_written(expected_log_hash.merge(severity: 'FATAL').to_json)
      expect(logger.fatal('this is a test', service: 'test_service')).to eq(true)
    end
  end

  describe 'with_context block' do
    let(:expected_log_hash) do
      {
        service: 'test_service',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }
    end

    it 'prints out the wrapper context when logging' do
      expect_log_line_to_be_written(expected_log_hash.to_json)

      logger.with_context(service: 'test_service') do
        expect(logger.info('this is a test')).to eq(true)
      end
    end

    it 'merges inline context into wrapper context when logging' do
      expect_log_line_to_be_written(expected_log_hash.merge(file: 'this_file.json').to_json)

      logger.with_context(service: 'test_service') do
        expect(logger.info('this is a test', file: 'this_file.json')).to eq(true)
      end
    end

    it 'takes inline context over wrapper context when logging' do
      expect_log_line_to_be_written(expected_log_hash.merge(service: 'test_service_2').to_json)

      logger.with_context(service: 'test_service') do
        expect(logger.info('this is a test', service: 'test_service_2')).to eq(true)
      end
    end

    it 'combines tiered contexts when logging' do
      expect_log_line_to_be_written(expected_log_hash.merge(file: 'this_file.json', service: 'test_service').to_json)

      logger.with_context(service: 'test_service') do
        logger.with_context(file: 'this_file.json') do
          expect(logger.info('this is a test')).to eq(true)
        end
      end
    end

    it 'returns the output of the block passed in' do
      expect(logger.with_context(service: 'test_service') { 6 }).to eq(6)
    end
  end

  describe 'with_context without block' do
    let(:expected_log_hash) do
      {
        service: 'test_service',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }
    end

    it 'returns a context handler' do
      expect(logger.with_context(service: 'test_service')).to be_a(ContextualLogger::Context::Handler)
    end

    it 'prints out the wrapper context with logging' do
      expect_log_line_to_be_written(expected_log_hash.to_json)

      handler = logger.with_context(service: 'test_service')
      expect(logger.info('this is a test')).to eq(true)
      handler.reset!
    end

    it 'merges inline context into wrapper context when logging' do
      expect_log_line_to_be_written(expected_log_hash.merge(file: 'this_file.json').to_json)

      handler = logger.with_context(service: 'test_service')
      expect(logger.info('this is a test', file: 'this_file.json')).to eq(true)
      handler.reset!
    end

    it 'takes inline context over wrapper context when logging' do
      expect_log_line_to_be_written(expected_log_hash.merge(service: 'test_service_2').to_json)

      handler = logger.with_context(service: 'test_service')
      expect(logger.info('this is a test', service: 'test_service_2')).to eq(true)
      handler.reset!
    end

    it 'combines tiered contexts when logging' do
      expect_log_line_to_be_written(expected_log_hash.merge(file: 'this_file.json', service: 'test_service').to_json)

      handler1 = logger.with_context(service: 'test_service')
      logger.with_context(file: 'this_file.json')
      expect(logger.info('this is a test')).to eq(true)
      handler1.reset!
    end
  end

  describe 'global_context' do
    let(:expected_log_hash) do
      {
        service: 'test_service',
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }
    end

    before do
      logger.global_context = { service: 'test_service' }
    end

    it 'prints out global context with log line' do
      expect_log_line_to_be_written(expected_log_hash.to_json)
      expect(logger.info('this is a test')).to eq(true)
    end

    it 'merges global context with inline context' do
      expect_log_line_to_be_written(expected_log_hash.merge(file: 'this_file.json').to_json)
      expect(logger.info('this is a test', file: 'this_file.json')).to eq(true)
    end

    it 'merges global context with with_context block' do
      expect_log_line_to_be_written(expected_log_hash.merge(file: 'this_file.json').to_json)
      logger.with_context(file: 'this_file.json') do
        expect(logger.info('this is a test')).to eq(true)
      end
    end
  end

  describe 'with varying levels of context' do
    let(:expected_log_hash) do
      {
        service: 'test_service',
        array_context: [3],
        hash_context: {
          apple: 'orange',
          hello: 'goodbye',
          pizza: 'bagel',
        },
        message: 'this is a test',
        severity: 'INFO',
        timestamp: Time.now,
        progname: nil
      }
    end

    it 'deep merges contexts with sub hashes' do
      expect_log_line_to_be_written(expected_log_hash.to_json)

      logger.global_context = { service: 'test_service', array_context: [1, 2] }
      logger.with_context(hash_context: { apple: 'orange', hello: 'world' }) do
        expect(logger.info('this is a test', array_context: [3], hash_context: { pizza: 'bagel', hello: 'goodbye' })).to eq(true)
      end
    end
  end
end
