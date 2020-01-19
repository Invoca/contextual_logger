# frozen_string_literal: true

require 'active_support'
require 'json'
require_relative './contextual_logger/context/handler'

module ContextualLogger
  def self.new(logger)
    logger.extend(self)
  end

  def global_context=(context)
    Context::Handler.new(context).set!
  end

  def with_context(context)
    context_handler = Context::Handler.new(current_context_for_thread.deep_merge(context))
    context_handler.set!
    if block_given?
      yield
    else
      context_handler
    end
  ensure
    context_handler.reset! if block_given?
  end

  def current_context_for_thread
    Context::Handler.current_context
  end

  def format_message(severity, timestamp, progname, message, context)
    message_with_context = message_with_context(context, message, severity, timestamp, progname)

    if @formatter
      @formatter.call(severity, timestamp, progname, message_with_context)
    else
      "#{message_with_context.to_json}\n"
    end
  end

  def debug(progname = nil, **extra_context, &block)
    add_if_enabled(Logger::Severity::DEBUG, nil, progname, extra_context, &block)
  end

  def info(progname = nil, **extra_context, &block)
    add_if_enabled(Logger::Severity::INFO, nil, progname, extra_context, &block)
  end

  def warn(progname = nil, **extra_context, &block)
    add_if_enabled(Logger::Severity::WARN, nil, progname, extra_context, &block)
  end

  def error(progname = nil, **extra_context, &block)
    add_if_enabled(Logger::Severity::ERROR, nil, progname, extra_context, &block)
  end

  def fatal(progname = nil, **extra_context, &block)
    add_if_enabled(Logger::Severity::FATAL, nil, progname, extra_context, &block)
  end

  def unknown(progname = nil, **extra_context, &block)
    add_if_enabled(Logger::Severity::UNKNOWN, nil, progname, extra_context, &block)
  end

  def log_level_enabled(severity)
    severity >= @level
  end

  def add_if_enabled(severity, message, progname, extra_context, &block)
    if @logdev && log_level_enabled(severity)
      add(severity, message, progname, extra_context, &block)
    end
    true
  end

  def add(severity, message, progname, extra_context)
    progname ||= @progname
    if message.nil?
      if block_given?
        message = yield
      else
        message = progname
        progname = @progname
      end
    end
    write_entry_to_log(severity, Time.now, progname, message, current_context_for_thread.deep_merge(extra_context || {}))
  end

  def write_entry_to_log(severity, timestamp, progname, message, context)
    @logdev.write(format_message(format_severity(severity), timestamp, progname, message, context))
  end

  private

  def message_with_context(context, message, severity, timestamp, progname)
    context.merge(
      message: message,
      severity: severity,
      timestamp: timestamp,
      progname: progname
    )
  end
end
