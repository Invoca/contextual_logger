# frozen_string_literal: true

module ContextualLogger
  module Context
    module RegistryTypes
      class Number
        attr_reader :formatter

        def initialize(formatter: nil)
          @formatter = formatter || :to_i
        end

        def to_h
          { type: :number, formatter: formatter }
        end
      end
    end
  end
end
