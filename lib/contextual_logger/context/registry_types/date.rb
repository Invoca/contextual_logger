# frozen_string_literal: true

module ContextualLogger
  module Context
    module RegistryTypes
      class Date
        attr_reader :formatter

        def initialize(formatter: nil)
          @formatter = formatter || ->(value) { value.iso8601(6) }
        end

        def to_h
          { type: :date, formatter: formatter }
        end

        def format(value)
          case formatter
          when Proc
            formatter.call(value)
          else
            value.send(formatter)
          end
        end
      end
    end
  end
end