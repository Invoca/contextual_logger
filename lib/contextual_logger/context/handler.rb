# frozen_string_literal: true

module ContextualLogger
  module Context
    class Handler
      THREAD_CONTEXT_NAMESPACE = 'ContextualLoggerCurrentLoggingContext'

      attr_reader :previous_context, :context

      class << self
        def current_context
          Thread.current[THREAD_CONTEXT_NAMESPACE] || {}
        end
      end

      def initialize(context, previous_context: nil)
        @previous_context = previous_context || self.class.current_context
        @context = context
      end

      def set!
        Thread.current[THREAD_CONTEXT_NAMESPACE] = context
      end

      def reset!
        Thread.current[THREAD_CONTEXT_NAMESPACE] = previous_context
      end
    end
  end
end
