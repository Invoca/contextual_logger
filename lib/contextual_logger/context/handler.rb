# frozen_string_literal: true

module ContextualLogger
  module Context
    def thread_context_for_logger_instance
      # We include the object_id here to make these thread/fiber locals unique per logger instance.
      @thread_context_for_logger_instance ||= "ContextualLogger::Context.context_for_#{object_id}".to_sym
    end

    def current_context(global_context)
      Thread.current[thread_context_for_logger_instance] || global_context
    end

    def current_context=(context)
      Thread.current[thread_context_for_logger_instance] = context.freeze
    end

    class Handler
      def initialize(instance, previous_context)
        @instance = instance
        @previous_context = previous_context
      end

      def reset!
        @instance.current_context = @previous_context
      end
    end
  end
end
