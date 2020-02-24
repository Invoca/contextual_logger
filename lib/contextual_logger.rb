# frozen_string_literal: true

require 'active_support'
require 'json'
require_relative './contextual_logger/context/handler'

module ContextualLogger
  class << self
    def new(logger)
      logger.extend(LoggerMixin)
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
      add_if_enabled(Logger::Severity::DEBUG, message || yield, context: context)
    end

    def info(message = nil, context = {})
      add_if_enabled(Logger::Severity::INFO, message || yield, context: context)
    end

    def warn(message = nil, context = {})
      add_if_enabled(Logger::Severity::WARN, message || yield, context: context)
    end

    def error(message = nil, context = {})
      add_if_enabled(Logger::Severity::ERROR, message || yield, context: context)
    end

    def fatal(message = nil, context = {})
      add_if_enabled(Logger::Severity::FATAL, message || yield, context: context)
    end

    def unknown(message = nil, context = {})
      add_if_enabled(Logger::Severity::UNKNOWN, message || yield, context: context)
    end

    def log_level_enabled?(severity)
      severity >= level
    end

    def add_if_enabled(severity, message, context:)
      if log_level_enabled?(severity)
        write_entry_to_log(severity, Time.now, @progname, message, context: current_context_for_thread.deep_merge(context))
      end
      true
    end

    def write_entry_to_log(severity, timestamp, progname, message, context:)
      @logdev&.write(format_message(format_severity(severity), timestamp, progname, message, context: context))
    end

    private

    def format_message(severity, timestamp, progname, message, context: {})
      message_with_context_hash = message_with_context(context, message, severity, timestamp, progname)

      if @formatter
        @formatter.call(severity, timestamp, progname, message_with_context_hash)
      else
        "#{message_with_context_hash.to_json}\n"
      end
    end

    def message_with_context(extra_context, message, severity, timestamp, progname)
      context =
        {
          message: message,
          severity: severity,
          timestamp: timestamp
        }
      extra_context[:progname] = progname if progname

      context.merge(extra_context)
    end
  end
end
