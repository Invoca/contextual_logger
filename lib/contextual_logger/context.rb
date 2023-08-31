# frozen_string_literal: true

module ContextualLogger
  module Context
    def thread_context_for_logger_instance
      # We include the object_id here to make these thread/fiber locals unique per logger instance.
      @thread_context_for_logger_instance ||= "ContextualLogger::Context.context_for_#{object_id}".to_sym
    end

    def current_context
      Thread.current[thread_context_for_logger_instance]
    end

    def current_context=(context)
      Thread.current[thread_context_for_logger_instance] = context.freeze
    end
  end
end
