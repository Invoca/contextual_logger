# frozen_string_literal: true

module ContextualLogger
  module Context
    EMPTY_CONTEXT = {}.freeze

    def thread_context_key_for_logger_instance
      # We include the object_id here to make these thread/fiber locals unique per logger instance.
      @thread_context_key_for_logger_instance ||= "ContextualLogger::Context.context_for_#{object_id}".to_sym
    end

    def current_context_override
      ContextualLogger.global_context_lock_message ||= "ContextualLogger::Context.current_context_override set for #{self.class.name} #{object_id}"
      Thread.current[thread_context_key_for_logger_instance]
    end

    def current_context_override=(context_override)
      Thread.current[thread_context_key_for_logger_instance] = context_override.freeze
    end
  end
end
