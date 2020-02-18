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
      yield
    else
      context_handler # JEB, is this actually useful? The set! and reset! wouldn't mean anything, so it would just be calling Context::Handler.new, right? -Colin
    end
  ensure
    context_handler.reset! if block_given?
  end

  def current_context_for_thread
    Context::Handler.current_context
  end

  def debug(message = nil, extra_context = {})
    add_if_enabled(Logger::Severity::DEBUG, message || yield, extra_context: extra_context)
  end

  def info(message = nil, extra_context = {})
    add_if_enabled(Logger::Severity::INFO, message || yield, extra_context: extra_context)
  end

  def warn(message = nil, extra_context = {})
    add_if_enabled(Logger::Severity::WARN, message || yield, extra_context: extra_context)
  end

  def error(message = nil, extra_context = {})
    add_if_enabled(Logger::Severity::ERROR, message || yield, extra_context: extra_context)
  end

  def fatal(message = nil, extra_context = {})
    add_if_enabled(Logger::Severity::FATAL, message || yield, extra_context: extra_context)
  end

  def unknown(message = nil, extra_context = {})
    add_if_enabled(Logger::Severity::UNKNOWN, message || yield, extra_context: extra_context)
  end

  def log_level_enabled?(severity)
    severity >= @level
  end

  def add_if_enabled(severity, message, extra_context:)
    if log_level_enabled?(severity)
      add(severity, message: message, progname: @progname, extra_context: extra_context)
    end
    true
  end

  def add(severity, message:, progname:, extra_context:)
    write_entry_to_log(severity, Time.now, progname, message, current_context_for_thread.deep_merge(extra_context))
  end

  def write_entry_to_log(severity, timestamp, progname, message, context)
    @logdev&.write(format_message(format_severity(severity), timestamp, progname, message, context))
  end

  private

  def format_message(severity, timestamp, progname, message, context)
    message_with_context = message_with_context(context, message, severity, timestamp, progname)

    if @formatter
      @formatter.call(severity, timestamp, progname, message_with_context)
    else
      "#{message_with_context.to_json}\n"
    end
  end

  def message_with_context(context, message, severity, timestamp, progname)
    extra_context =
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
