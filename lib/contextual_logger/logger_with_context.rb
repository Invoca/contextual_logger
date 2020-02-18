# frozen_string_literal: true

module ContextualLogger
  # A logger that deep_merges additional context and then delegates to the given logger.
  # Keeps it own log level that may be set independently of the logger it delegates to (the latter's log level is ignored).
  class LoggerWithContext
    include LoggerMixin

    attr_accessor :level
    attr_reader :context

    def initialize(logger, context, level: nil)
      @logger = logger
      @level = level || logger.level
      @context = context
      @merged_context_cache = {}  # so we don't have to merge every time
    end

    def write_entry_to_log(severity, timestamp, progname, message, context)
      if @merged_context_cache.size > 5000 # keep this cache memory use finite
        @merged_context_cache = {}
      end
      merged_context = @merged_context_cache[context] ||= @context.deep_merge(context)
      @logger.write_entry_to_log(severity, timestamp, progname, message, merged_context)
    end

    class << self
      def for_log_source(logger, log_source)
        new(logger, log_source: log_source)
      end
    end
  end
end
