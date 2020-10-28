# frozen_string_literal: true

module ContextualLogger
  module Context
    module RegistryTypes
      class Boolean
        attr_reader :formatter

        def initialize(formatter: nil)
          @formatter = formatter || ->(value) { value ? true : false }
        end

        def to_h
          { type: :boolean, formatter: formatter }
        end
      end
    end
  end
end
