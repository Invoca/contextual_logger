# frozen_string_literal: true

module ContextualLogger
  class ContextHandler
    def initialize(instance, previous_context)
      @instance = instance
      @previous_context = previous_context
    end

    def reset!
      @instance.current_context = @previous_context
    end
  end
end
