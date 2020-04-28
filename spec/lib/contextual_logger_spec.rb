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

describe ContextualLogger do
  before(:each) { Time.now_override = Time.now }
  after(:each)  { logger.global_context = {} }

  subject(:logger) { ContextualLogger.new(Logger.new('/dev/null')) }

  it { is_expected.to respond_to(:with_context) }

  context 'with logger writing to log_stream' do
    let(:log_stream) { StringIO.new }
    let(:log_level) { Logger::Severity::DEBUG }
    let(:logger) { ContextualLogger.new(Logger.new(log_stream, level: log_level)) }

    describe 'log level' do
      context 'at default level' do
        it 'respects log level debug' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["debug", "info", "warn", "error", "fatal", "unknown"])
        end
      end

      context 'at level debug' do
        let(:log_level) { Logger::Severity::DEBUG }

        it 'respects log level' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["debug", "info", "warn", "error", "fatal", "unknown"])
        end
      end

      context 'at level info' do
        let(:log_level) { Logger::Severity::INFO }

        it 'respects log level' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["info", "warn", "error", "fatal", "unknown"])
        end
      end

      context 'at level warn' do
        let(:log_level) { Logger::Severity::WARN }

        it 'respects log level' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["warn", "error", "fatal", "unknown"])
        end
      end

      context 'at level error' do
        let(:log_level) { Logger::Severity::ERROR }

        it 'respects log level' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["error", "fatal", "unknown"])
        end
      end

      context 'at level fatal' do
        let(:log_level) { Logger::Severity::FATAL }

        it 'respects log level' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["fatal", "unknown"])
        end
      end

      context 'at level unknown' do
        let(:log_level) { Logger::Severity::UNKNOWN }

        it 'respects log level' do
          log_at_every_level(logger)
          expect(log_message_levels).to eq(["unknown"])
        end
      end
    end

    describe 'when used with ActiveSupport::Logger.broadcast' do
      let(:log_level) { Logger::Severity::ERROR }
      let(:console_log_stream) { StringIO.new }
      let(:console_logger) { Logger.new(console_log_stream) }
      let(:broadcast_logger) { logger.extend(ActiveSupport::Logger.broadcast(console_logger)) }

      it 'properly broadcasts to both logs when level-named method is called' do
        log_at_every_level(broadcast_logger, service: 'test_service')
        expect(log_message_levels).to eq(["error", "fatal", "unknown"])
        # note: context lands in `progname` arg
        expect(console_log_stream.string.gsub(/\[[^]]+\]/, '[]')).to eq(<<~EOS)
          D, [] DEBUG -- {:service=>\"test_service\"}: debug message
          I, []  INFO -- {:service=>\"test_service\"}: info message
          W, []  WARN -- {:service=>\"test_service\"}: warn message
          E, [] ERROR -- {:service=>\"test_service\"}: error message
          F, [] FATAL -- {:service=>\"test_service\"}: fatal message
          A, []   ANY -- {:service=>\"test_service\"}: unknown message
        EOS
      end

      it 'properly broadcasts to both logs when add is called' do
        broadcast_logger.add(Logger::Severity::ERROR, "error message", service: 'test_service')
        expect(log_message_levels).to eq(["error"])
        # note: context lands in `progname` arg
        expect(console_log_stream.string.gsub(/\[[^]]+\]/, '[]')).to eq("E, [] ERROR -- {:service=>\"test_service\"}: error message\n")
      end
    end

    describe 'with nil message' do
      it "logs null" do
        logger.level = Logger::Severity::DEBUG
        log_message_at_every_level(logger, nil)

        expect(log_stream.string.gsub(/"timestamp":"[^"]+"/, '<time>')).to eq(<<~EOS)
          {"message":"nil","severity":"DEBUG",<time>}
          {"message":"nil","severity":"INFO",<time>}
          {"message":"nil","severity":"WARN",<time>}
          {"message":"nil","severity":"ERROR",<time>}
          {"message":"nil","severity":"FATAL",<time>}
          {"message":"nil","severity":"ANY",<time>}
        EOS
      end
    end

    describe 'with false message' do
      it "logs false" do
        logger.level = Logger::Severity::DEBUG
        log_message_at_every_level(logger, false)

        expect(log_stream.string.gsub(/"timestamp":"[^"]+"/, '"timestamp":"<time>"')).to eq(<<~EOS)
          {"message":"false","severity":"DEBUG","timestamp":"<time>"}
          {"message":"false","severity":"INFO","timestamp":"<time>"}
          {"message":"false","severity":"WARN","timestamp":"<time>"}
          {"message":"false","severity":"ERROR","timestamp":"<time>"}
          {"message":"false","severity":"FATAL","timestamp":"<time>"}
          {"message":"false","severity":"ANY","timestamp":"<time>"}
        EOS
      end
    end
  end

  describe 'inline context' do
    let(:expected_log_hash) do
      {
        service: 'test_service',
        message: 'this is a test',
        timestamp: Time.now
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
        timestamp: Time.now
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
        timestamp: Time.now
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
        timestamp: Time.now
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
        timestamp: Time.now
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

  describe 'add' do
    let(:log_stream) { StringIO.new }
    let(:logger) { ContextualLogger.new(Logger.new(log_stream, level: Logger::Severity::DEBUG)) }

    it "preserves the Logger interface with message only" do
      expect(logger.add(Logger::Severity::INFO, "info message")).to eq(true)
      expect(log_stream.string).to match(/\{"message":"info message","severity":"INFO","timestamp":".*"\}/)
    end

    it "preserves the Logger interface with nil message & block" do
      expect(logger.add(Logger::Severity::INFO, nil) { "info message" }).to eq(true)
      expect(log_stream.string).to match(/\{"message":"info message","severity":"INFO","timestamp":".*"\}/)
    end

    it "preserves the Logger interface with nil message & message in progname spot" do
      expect(logger.add(Logger::Severity::INFO, nil, "info message")).to eq(true)
      expect(log_stream.string).to match(/\{"message":"info message","severity":"INFO","timestamp":".*"\}/)
    end
  end

  LOG_LEVEL_STRINGS_TO_CONSTANTS =
  {
    "DEBUG"   => Logger::Severity::DEBUG,
    "INFO"    => Logger::Severity::INFO,
    "WARN"    => Logger::Severity::WARN,
    "ERROR"   => Logger::Severity::ERROR,
    "FATAL"   => Logger::Severity::FATAL,
    "UNKNOWN" => Logger::Severity::UNKNOWN
  }.freeze

  describe 'module methods' do
    describe "normalize_log_level" do
      it "raises an exception on invalid values" do
        [nil, "", "ABC", 3.5].each do |invalid_value|
          expect { ContextualLogger.normalize_log_level(invalid_value) }.to raise_exception(ArgumentError, /invalid log level:/), invalid_value
        end
      end

      it "accepts Severity constants" do
        LOG_LEVEL_STRINGS_TO_CONSTANTS.each do |_uppercase_string_level, constant_level|
          expect(ContextualLogger.normalize_log_level(constant_level)).to eq(constant_level)
        end
      end

      it "accepts uppercase strings" do
        LOG_LEVEL_STRINGS_TO_CONSTANTS.each do |uppercase_string_level, constant_level|
          expect(ContextualLogger.normalize_log_level(uppercase_string_level)).to eq(constant_level)
        end
      end

      it "accepts uppercase symbols" do
        LOG_LEVEL_STRINGS_TO_CONSTANTS.each do |uppercase_string_level, constant_level|
          uppercase_symbol_level = uppercase_string_level.to_sym
          expect(ContextualLogger.normalize_log_level(uppercase_symbol_level)).to eq(constant_level)
        end
      end

      it "accepts lowercase strings" do
        LOG_LEVEL_STRINGS_TO_CONSTANTS.each do |uppercase_string_level, constant_level|
          lowercase_string_level = uppercase_string_level.downcase
          expect(ContextualLogger.normalize_log_level(lowercase_string_level)).to eq(constant_level)
        end
      end

      it "accepts lowercase symbols" do
        LOG_LEVEL_STRINGS_TO_CONSTANTS.each do |uppercase_string_level, constant_level|
          lowercase_symbol_level = uppercase_string_level.downcase.to_sym
          expect(ContextualLogger.normalize_log_level(lowercase_symbol_level)).to eq(constant_level)
        end
      end
    end

    describe "normalize_message" do
      class CustomInspect
        def inspect
          "<custom>"
        end
      end

      describe 'with nil' do
        it "returns 'nil'" do
          expect(ContextualLogger.normalize_message(nil)).to eq("nil")
        end
      end

      describe 'with false' do
        it "returns 'false'" do
          expect(ContextualLogger.normalize_message(false)).to eq("false")
        end
      end

      describe 'with a symbol' do
        it "returns :symbol" do
          expect(ContextualLogger.normalize_message(:symbol)).to eq(":symbol")
        end
      end

      describe 'with a custom #inspect' do
        it "returns .inspect" do
          expect(ContextualLogger.normalize_message(CustomInspect.new)).to eq("<custom>")
        end
      end

      describe 'with an Exception' do
        it "returns .inspect (skipping the backtrace)" do
          expect(ContextualLogger.normalize_message(ArgumentError.new("err"))).to eq("#<ArgumentError: err>")
        end
      end
    end
  end

  describe 'with redaction' do
    let(:sensitive_data) { 'sensitive_string_123' }

    before(:each) do
      logger.register_secret(sensitive_data)
    end

    describe 'with sensitive data in the message' do
      let(:expected_log_hash) do
        {
          severity: 'DEBUG',
          service: 'test_service',
          message: 'this is a test with ******',
          timestamp: Time.now
        }
      end

      it 'replaces sensitive data with ******' do
        expect_log_line_to_be_written(expected_log_hash.to_json)
        expect(logger.debug("this is a test with #{sensitive_data}", service: 'test_service')).to eq(true)
      end
    end

    describe 'with sensitive data in the context' do
      let(:expected_log_hash) do
        {
          severity: 'DEBUG',
          service: 'test_service',
          message: 'this is a test',
          password: '******',
          timestamp: Time.now
        }
      end

      it 'replaces sensitive data with ******' do
        expect_log_line_to_be_written(expected_log_hash.to_json)
        expect(logger.debug("this is a test", service: 'test_service', password: sensitive_data)).to eq(true)
      end
    end

    describe 'with sensitive data that includes special escaped characters' do
      let(:expected_log_hash) do
        {
          severity: 'DEBUG',
          service: 'test_service',
          message: 'this is a test',
          password: '******',
          timestamp: Time.now
        }
      end

      let(:sensitive_data) { '"' }

      it 'replaces sensitive data with ******' do
        expect_log_line_to_be_written(expected_log_hash.to_json)
        expect(logger.debug("this is a test", service: 'test_service', password: sensitive_data)).to eq(true)
      end
    end
  end
end
