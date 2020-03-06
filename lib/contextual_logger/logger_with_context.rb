# frozen_string_literal: true

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
      @context = context
      @merged_context_cache = {}  # so we don't have to merge every time
    end

    def level
      @override_level || @logger.level
    end

    def level=(override_level)
      @override_level = ContextualLogger.normalize_log_level(override_level)
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

    class << self
      def for_log_source(logger, log_source, level: nil)
        new(logger, { log_source: log_source }, level: level)
      end
    end
  end
end
