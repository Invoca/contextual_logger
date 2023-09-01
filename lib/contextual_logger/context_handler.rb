# frozen_string_literal: true

module ContextualLogger
  class ContextHandler
    def initialize(instance, previous_context_override)
      @instance = instance
      @previous_context_override = previous_context_override
    end

    def reset!
      @instance.current_context_override = @previous_context_override
    end
  end
end
