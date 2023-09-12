# frozen_string_literal: true

module ContextualLogger
  class << self
    attr_accessor :global_context_lock_message # nil or a string indicating what locked the global context
  end

  class GlobalContextIsLocked < StandardError
  end
end
