# frozen_string_literal: true

require 'active_support'
require 'json'
require_relative './contextual_logger/context/handler'

module ContextualLogger
  class << self
    def new(logger)
      logger.extend(LoggerMixin)
    end

    def normalize_log_level(log_level)
      if log_level.is_a?(Integer) && (Logger::Severity::DEBUG..Logger::Severity::UNKNOWN).include?(log_level)
        log_level
      else
        case log_level.to_s.downcase
        when 'debug'
          Logger::Severity::DEBUG
        when 'info'
          Logger::Severity::INFO
        when 'warn'
          Logger::Severity::WARN
        when 'error'
          Logger::Severity::ERROR
        when 'fatal'
          Logger::Severity::FATAL
        when 'unknown'
          Logger::Severity::UNKNOWN
        else
          raise ArgumentError, "invalid log level: #{log_level.inspect}"
        end
      end
    end
  end

  module LoggerMixin
    def global_context=(context)
      Context::Handler.new(context).set!
    end

    def with_context(context)
      context_handler = Context::Handler.new(current_context_for_thread.deep_merge(context))
      context_handler.set!
      if block_given?
        begin
          yield
        ensure
          context_handler.reset!
        end
      else
        # If no block given, the context handler is returned to the caller so they can handle reset! themselves.
        context_handler
      end
    end

    def current_context_for_thread
      Context::Handler.current_context
    end

    def debug(message = nil, context = {})
      add(Logger::Severity::DEBUG, message || yield, **context)
    end

    def info(message = nil, context = {})
      add(Logger::Severity::INFO, message || yield, **context)
    end

    def warn(message = nil, context = {})
      add(Logger::Severity::WARN, message || yield, **context)
    end

    def error(message = nil, context = {})
      add(Logger::Severity::ERROR, message || yield, **context)
    end

    def fatal(message = nil, context = {})
      add(Logger::Severity::FATAL, message || yield, **context)
    end

    def unknown(message = nil, context = {})
      add(Logger::Severity::UNKNOWN, message || yield, **context)
    end

    def log_level_enabled?(severity)
      severity >= level
    end

    def add(init_severity, message = nil, init_progname = nil, **context)   # Ruby will prefer to match hashes up to last ** argument
      severity = init_severity || UNKNOWN
      if log_level_enabled?(severity)
        progname = init_progname || @progname
        if message.nil?
          if block_given?
            message = yield
          else
            message = init_progname
            progname = @progname
          end
        end
        write_entry_to_log(severity, Time.now, progname, message, context: current_context_for_thread.deep_merge(context))
      end

      true
    end

    def write_entry_to_log(severity, timestamp, progname, message, context:)
      @logdev&.write(format_message(format_severity(severity), timestamp, progname, message, context: context))
    end

    private

    def format_message(severity, timestamp, progname, message, context: {})
      message_hash = message_hash_with_context(severity, timestamp, progname, message, context: context)

      if @formatter
        @formatter.call(severity, timestamp, progname, message_hash)
      else
        "#{message_hash.to_json}\n"
      end
    end

    def message_hash_with_context(severity, timestamp, progname, message, context:)
      message_hash =
        {
          message:   message,
          severity:  severity,
          timestamp: timestamp
        }
      message_hash[:progname] = progname if progname

      message_hash.merge!(context)
    end
  end
end
