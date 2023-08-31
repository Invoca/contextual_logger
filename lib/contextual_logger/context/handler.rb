# frozen_string_literal: true

module ContextualLogger
  module Context
    THREAD_CONTEXT_NAMESPACE = :'ContextualLogger::Context.current_context'

    class << self
      def current_context(global_context)
        Thread.current[THREAD_CONTEXT_NAMESPACE] || global_context
      end

      def current_context=(context)
        Thread.current[THREAD_CONTEXT_NAMESPACE] = context.freeze
      end
    end

    class Handler
      def initialize(previous_context)
        @previous_context = previous_context
      end

      def reset!
        ::ContextualLogger::Context.current_context = @previous_context
      end
    end
  end
end
