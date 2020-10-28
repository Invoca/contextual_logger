# frozen_string_literal: true

require_relative 'registry_types/string'
require_relative 'registry_types/boolean'
require_relative 'registry_types/number'
require_relative 'registry_types/date'
require_relative 'registry_types/hash'

# This class is responsible for holding the registered context shape that will
# be used by the LoggerMixin to make sure that the context matches the shape
# defined

# logger.configure_context do
#   strict false
#
#   string test_string
#   integer test_integer
#   hash :test_hash do
#     string :test_string_in_hash
#     date :date_time_in_hash
#   end
# end

module ContextualLogger
  module Context
    class Registry < RegistryTypes::Hash
      class DuplicateDefinitionError < StandardError; end
      class MissingDefinitionError < StandardError; end

      def initialize(&definitions)
        @strict                        = true
        @raise_on_missing_definition = true

        super
      end

      def strict?
        @strict
      end

      def raise_on_missing_definition?
        @raise_on_missing_definition
      end

      def format(context)
        if strict?
          super(context, raise_on_missing_definition?)
        else
          context
        end
      end

      alias context_shape to_h

      def to_h
        {
          strict: @strict,
          context_shape: context_shape
        }
      end

      private

      def strict(value)
        @strict = value
      end

      def raise_on_missing_definition(value)
        @raise_on_missing_definition = value
      end
    end
  end
end
