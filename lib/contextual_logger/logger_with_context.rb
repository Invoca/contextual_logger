# frozen_string_literal: true

require 'active_support/core_ext/hash/keys'

module ContextualLogger
  # A logger that deep_merges additional context and then delegates to the given logger.
  # Keeps it own log level (called override_level) that may be set independently of the logger it delegates to.
  # If override_level is non-nil, it takes precedence; if it is nil (the default), then it delegates to the logger.
  class LoggerWithContext
    include LoggerMixin

    attr_reader :logger, :override_level, :context

    def initialize(logger, context, level: nil)
      logger.is_a?(LoggerMixin) or raise ArgumentError, "logger must include ContextualLogger::LoggerMixin (got #{logger.inspect})"
      @logger = logger
      self.level = level
      @context = normalize_context(context)
      @merged_context_cache = {}  # so we don't have to merge every time
    end

    def level
      @override_level || @logger.level
    end

    def level=(override_level)
      @override_level = (ContextualLogger.normalize_log_level(override_level) if override_level)
    end

    def write_entry_to_log(severity, timestamp, progname, message, context:)
      merged_context =
        if @merged_context_cache.size >= 1000 # keep this cache memory use finite
          @merged_context_cache[context] || @context.deep_merge(context)
        else
          @merged_context_cache[context] ||= @context.deep_merge(context)
        end

      @logger.write_entry_to_log(severity, timestamp, progname, message, context: merged_context)
    end

    def normalize_context(context)
      if warn_on_string_keys(context)
        context.deep_symbolize_keys
      else
        context
      end
    end

    def warn_on_string_keys(context)
      if deep_key_has_string?(context)
        ActiveSupport::Deprecation.warn('Context keys must use symbols not strings. This will be asserted as of contextual_logger v1.0.0')
      end
    end

    def deep_key_has_string?(hash)
      hash.any? do |key, value|
        key.is_a?(String) ||
            (value.is_a?(Hash) && deep_key_has_string?(value))
      end
    end

    class << self
      def for_log_source(logger, log_source, level: nil)
        new(logger, { log_source: log_source }, level: level)
      end
    end
  end
end
