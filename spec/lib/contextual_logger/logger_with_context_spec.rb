# frozen_string_literal: true

require 'spec_helper'
require 'logger'
require 'contextual_logger'
require 'contextual_logger/logger_with_context'
require 'json'

describe ContextualLogger::LoggerWithContext do
  context "when created with a base logger" do
    let(:log_stream) { StringIO.new }
    let(:base_logger) { Logger.new(log_stream, level: Logger::Severity::FATAL).extend(ContextualLogger::LoggerMixin) }
    let(:context) { { log_source: "redis_client" } }

    subject(:logger_with_context) { ContextualLogger::LoggerWithContext.new(base_logger, context) }

    it "adds context" do
      subject.fatal("fatal message")
      expect(log_stream.string).to match(/\{"message":"fatal message","severity":"FATAL","timestamp":".*","log_source":"redis_client"\}/)
    end

    it "merges context" do
      subject.fatal("fatal message", call_id: "234-123")
      expect(log_stream.string).to match(/\{"message":"fatal message","severity":"FATAL","timestamp":".*","log_source":"redis_client","call_id":"234-123"\}/)
    end

    it "allows context to be overridden" do
      subject.fatal("fatal message", log_source: "frontend")
      expect(log_stream.string).to match(/\{"message":"fatal message","severity":"FATAL","timestamp":".*","log_source":"frontend"\}/)
    end

    context "context caching" do
      it "caches contexts to avoid merging over and over (but caps the cache size)" do
        subject.fatal("fatal message", log_source: "frontend")
        expect(subject.instance_variable_get(:@merged_context_cache).keys).to eq([{ log_source: "frontend" }])
        subject.fatal("fatal message", log_source: "redis_client")
        expect(subject.instance_variable_get(:@merged_context_cache).keys).to eq([{ log_source: "frontend" }, { log_source: "redis_client" }])
        998.times do |i|
          subject.fatal("fatal message", log_source: "gem #{i}")
        end
        expect(subject.instance_variable_get(:@merged_context_cache).size).to eq(1000)
        subject.fatal("fatal message", log_source: "gem 1000")
        expect(subject.instance_variable_get(:@merged_context_cache).size).to eq(1000)
      end
    end

    context "log level changes" do
      it "defaults to the base log level" do
        expect(subject.level).to eq(Logger::Severity::FATAL)
        log_at_every_level(logger_with_context)
        expect(log_message_levels).to eq(["fatal", "unknown"])
      end

      it "follows changes to the base log level when default level is used" do
        subject
        base_logger.level = Logger::Severity::INFO
        log_at_every_level(subject)
        expect(log_message_levels).to eq(["info", "warn", "error", "fatal", "unknown"])
      end

      it "can change its own log_level and then ignores changes to the base log level (as long as it's non-nil)" do
        subject.level = Logger::Severity::INFO
        base_logger.level = Logger::Severity::WARN
        expect(subject.override_level).to eq(Logger::Severity::INFO)
        log_at_every_level(subject)
        expect(log_message_levels).to eq(["info", "warn", "error", "fatal", "unknown"])
        log_stream.string.clear
        subject.level = nil
        expect(subject.override_level).to eq(nil)
        log_at_every_level(subject)
        expect(log_message_levels).to eq(["warn", "error", "fatal", "unknown"])
      end

      context "when constructed with its own level" do
        subject(:logger_with_context) { ContextualLogger::LoggerWithContext.new(base_logger, context, level: Logger::Severity::WARN) }

        it "respects its own log_level and ignores changes to the base log level" do
          expect(subject.override_level).to eq(Logger::Severity::WARN)
          log_at_every_level(subject)
          expect(log_message_levels).to eq(["warn", "error", "fatal", "unknown"])
          log_stream.string.clear
          base_logger.level = Logger::Severity::FATAL
          log_at_every_level(subject)
          expect(log_message_levels).to eq(["warn", "error", "fatal", "unknown"])
        end
      end

      context "with string log level" do
        it "allows creating" do
          logger_with_context = ContextualLogger::LoggerWithContext.new(base_logger, context, level: 'INFO')
          expect(logger_with_context.level).to eq(Logger::Severity::INFO)
        end

        it "allows assignment" do
          logger_with_context = ContextualLogger::LoggerWithContext.new(base_logger, context)
          logger_with_context.level = 'ERROR'
          expect(logger_with_context.level).to eq(Logger::Severity::ERROR)
        end
      end
    end

    context "when string passed as context key" do
      it "returns context with a symbol key" do
        context_with_string_key = { "log_source" => "redis_client" }
        string_context = ContextualLogger::LoggerWithContext.new(base_logger, context_with_string_key)
        expect(string_context.context).to eq(log_source: "redis_client")
      end

      it "returns a deep context with symbol key" do
        context_with_string_key_levels = { :log_source => { :level1 => { :level2 => { "level3" => "redis_client" } } } }
        string_context = ContextualLogger::LoggerWithContext.new(base_logger, context_with_string_key_levels)
        expect(string_context.context)
          .to eq({ log_source: { level1: { level2: { level3: "redis_client" } } } })
      end

      it "should return a deprecation warning" do
        context_with_string_key = { "log_source"=>"redis_client" }
        expect { ContextualLogger::LoggerWithContext.new(base_logger, context_with_string_key) }
          .to output(/DEPRECATION WARNING: Context keys must use symbols not strings/).to_stderr
      end
    end

    context "when base logger doesn't include LoggerMixin" do
      let(:base_logger) { Object.new }

      it "raises ArgumentError" do
        expect { subject }.to raise_exception(ArgumentError, /logger must include ContextualLogger::LoggerMixin \(got .*\)/)
      end
    end

    context "for_log_source" do
      subject(:logger_with_context) { ContextualLogger::LoggerWithContext.for_log_source(base_logger, "frontend") }

      it "creates a new logger_with_context using that log_source" do
        subject.fatal("fatal message")
        expect(log_stream.string).to match(/\{"message":"fatal message","severity":"FATAL","timestamp":".*","log_source":"frontend"\}/)
      end

      it "creates a new logger_with_context using that log_source and level:" do
        logger = ContextualLogger::LoggerWithContext.for_log_source(base_logger, "frontend", level: Logger::Severity::FATAL)
        logger.fatal("fatal message")
        logger.error("error message")
        expect(log_stream.string).to match(/\{"message":"fatal message","severity":"FATAL","timestamp":".*","log_source":"frontend"\}/)
        expect(log_stream.string).to_not match(/error message/)
      end
    end
  end
end
