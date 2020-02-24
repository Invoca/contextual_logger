# frozen_string_literal: true

module ContextualLogger
  # A logger that deep_merges additional context and then delegates to the given logger.
  # Keeps it own log level (called override_level) that may be set independently of the logger it delegates to.
  # If override_level is non-nil, it takes precedence; if it is nil (the default), then it delegates to the logger.
  class LoggerWithContext
    include LoggerMixin

    attr_reader :logger, :override_level, :context

    def initialize(logger, context, level: nil)
      @logger = logger
      @override_level = level
      @context = context
      @merged_context_cache = {}  # so we don't have to merge every time
    end

    def level
      @override_level || @logger.level
    end

    def level=(override_level)
      @override_level = override_level
    end

    def write_entry_to_log(severity, timestamp, progname, message, context:)
      if @merged_context_cache.size >= 5000 # keep this cache memory use finite
        @merged_context_cache = {}
      end
      merged_context = @merged_context_cache[context] ||= @context.deep_merge(context)
      @logger.write_entry_to_log(severity, timestamp, progname, message, context: merged_context)
    end

    class << self
      def for_log_source(logger, log_source)
        new(logger, log_source: log_source)
      end
    end
  end
end
