# frozen_string_literal: true

require 'active_support'
require 'active_support/core_ext/module/delegation'
require 'json'
require_relative './contextual_logger/redactor'
require_relative './contextual_logger/context'
require_relative './contextual_logger/context_handler'
require_relative './contextual_logger/global_context_lock_message'

module ContextualLogger
  LOG_LEVEL_NAMES_TO_SEVERITY =
  {
    debug:  Logger::Severity::DEBUG,
    info:   Logger::Severity::INFO,
    warn:   Logger::Severity::WARN,
    error:  Logger::Severity::ERROR,
    fatal:  Logger::Severity::FATAL,
    unknown: Logger::Severity::UNKNOWN
  }.freeze

  class LambdaAlreadyDefinedError < StandardError
  end

  class << self
    def new(logger)
      logger.extend(LoggerMixin)
    end
    deprecate :new, deprecator: ActiveSupport::Deprecation.new('1.0', 'contextual_logger')

    def normalize_log_level(log_level)
      if log_level.is_a?(Integer) && (Logger::Severity::DEBUG..Logger::Severity::UNKNOWN).include?(log_level)
        log_level
      else
        LOG_LEVEL_NAMES_TO_SEVERITY[log_level.to_s.downcase.to_sym] or
          raise ArgumentError, "invalid log level: #{log_level.inspect}"
      end
    end

    def normalize_message(message)
      case message
      when String
        message
      else
        message.inspect
      end
    end
  end

  # Context Precedence when this is mixed into a logger:
  # 1. inline **context passed to the logger method
  # 2. `with_context` overrides on the logger object
  # 3. `global_context` set on the logger passed to this constructor
  module LoggerMixin
    include Context

    delegate :register_secret, :register_secret_regex, to: :redactor

    def global_context
      @global_context ||= Context::EMPTY_CONTEXT
    end

    def add_global_context_lambda(field, lambda)
      if field.blank?
        raise ArgumentError, "The field cannot be empty"
      end

      unless lambda.respond_to?(:call)
        raise ArgumentError, "A lambda must respond to the :call method"
      end

      if global_context_lambdas[field]
        raise ::ContextualLogger::LambdaAlreadyDefinedError, "A lambda for `#{field}` is already defined"
      end

      @global_context_lambdas[field] = lambda
    end

    def global_context_lambdas
      @global_context_lambdas ||= {}
    end

    def global_context=(context)
      if (global_context_lock_message = ::ContextualLogger.global_context_lock_message)
        raise ::ContextualLogger::GlobalContextIsLocked, global_context_lock_message
      end
      @global_context = context.freeze
    end

    def current_context
      current_context_override || global_context
    end

    # TODO: Deprecate current_context_for_thread in v2.0.
    alias current_context_for_thread current_context

    def with_context(stacked_context)
      context_handler = ContextHandler.new(self, current_context_override)
      self.current_context_override = deep_merge_with_current_context(stacked_context)

      if block_given?
        begin
          yield
        ensure
          context_handler.reset!
        end
      else
        # If no block given, return context handler to the caller so they can call reset! themselves.
        context_handler
      end
    end

    # In the methods generated below, we assume that presence of context means new code that is
    # aware of ContextualLogger...and that that code never uses progname.
    # This is important because we only get 3 args total (not including &block) passed to `add`,
    # in order to be compatible with classic implementations like in the plain ::Logger and
    # ActiveSupport::Logger.broadcast.

    # Note that we can't yield before `add` because `add` might skip it based on log_level. And we can't check
    # log_level here because we might be running in ActiveSupport::Logging.broadcast which has multiple
    # loggers, each with their own log_level.

    LOG_LEVEL_NAMES_TO_SEVERITY.each do |method_name, log_level|
      class_eval(<<~EOS, __FILE__, __LINE__ + 1)
        def #{method_name}(arg = nil, **context, &block)
          if context.empty?
            add(#{log_level}, nil, arg, &block)
          else
            if arg.nil?
              add(#{log_level}, nil, **context, &block)
            elsif block
              add(#{log_level}, nil, **context.merge(progname: arg), &block)
            else
              add(#{log_level}, arg, **context)
            end
          end
        end
      EOS
    end

    def log_level_enabled?(severity)
      severity >= level
    end

    # Note that this interface needs to stay compatible with the underlying ::Logger#add interface,
    # which is: def add(severity, message = nil, progname = nil)
    def add(arg_severity, arg1 = nil, arg2 = nil, **context)   # Ruby will prefer to match hashes to last argument because of **
      severity = arg_severity || UNKNOWN
      if log_level_enabled?(severity)
        if arg1.nil?
          if block_given?
            message = yield
            progname = arg2 || context.delete(:progname) || @progname
          else
            message = arg2
            progname = @progname
          end
        else
          message = arg1
          progname = arg2 || @progname
        end
        full_context = evaluate_global_context_lambdas(deep_merge_with_current_context(context))
        write_entry_to_log(severity, Time.now, progname, message, context: full_context)
      end

      true
    end

    def write_entry_to_log(severity, timestamp, progname, message, context:)
      @logdev&.write(
        redactor.redact(
          format_message(format_severity(severity), timestamp, progname, message, context: context)
        )
      )
    end

    private

    def redactor
      @redactor ||= Redactor.new
    end

    def format_message(severity, timestamp, progname, message, context: {})
      normalized_message = ContextualLogger.normalize_message(message)
      normalized_progname = ContextualLogger.normalize_message(progname) unless progname.nil?
      if @formatter
        @formatter.call(severity, timestamp, normalized_progname, { message: normalized_message, **context })
      else
        "#{basic_json_log_entry(severity, timestamp, normalized_progname, normalized_message, context: context)}\n"
      end
    end

    def basic_json_log_entry(severity, timestamp, normalized_progname, normalized_message, context:)
      message_hash = {
        message: normalized_progname ? "#{normalized_progname}: #{normalized_message}" : normalized_message,
        severity:  severity,
        timestamp: timestamp,
        **context
      }
      message_hash[:progname] = normalized_progname if normalized_progname

      message_hash.to_json
    end

    def deep_merge_with_current_context(stacked_context)
      if stacked_context.any?
        current_context.deep_merge(stacked_context)
      else
        current_context
      end
    end

    def evaluate_global_context_lambdas(context)
      if global_context_lambdas.empty?
        context
      else
        global_context_lambdas.transform_values { |lambda| lambda.call }.merge(context)
      end
    end
  end
end
