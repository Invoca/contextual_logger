# frozen_string_literal: true

require_relative 'registry_types/string'
require_relative 'registry_types/boolean'
require_relative 'registry_types/number'
require_relative 'registry_types/date'

# This class is responsible for holding the registered context shape that will
# be used by the Context::Handler to make sure that the context matches the shape

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
    class Registry
      class DuplicateDefinitionError < StandardError; end

      attr_reader :context_shape

      def initialize(&definitions)
        @strict        = true
        @context_shape = {}

        run(&definitions)
      end

      def strict?
        @strict
      end

      def context_shape_hash
        context_shape.reduce({}) { |shape_hash, (key, value)| shape_hash.merge(key => value.to_h) }
      end

      private

      def strict(value)
        @strict = value
      end

      def string(context_key, formatter: nil)
        dedup(context_key, :string)
        @context_shape[context_key] = RegistryTypes::String.new(formatter: formatter)
      end

      def boolean(context_key, formatter: nil)
        dedup(context_key, :boolean)
        @context_shape[context_key] = RegistryTypes::Boolean.new(formatter: formatter)
      end

      def number(context_key, formatter: nil)
        dedup(context_key, :number)
        @context_shape[context_key] = RegistryTypes::Number.new(formatter: formatter)
      end

      def date(context_key, formatter: nil)
        dedup(context_key, :date)
        @context_shape[context_key] = RegistryTypes::Date.new(formatter: formatter)
      end

      def run(&definitions)
        instance_eval(&definitions)
      end

      def dedup(key, type)
        @context_shape.include?(key) and
          raise DuplicateDefinitionError, "Defining duplicate entry #{key} previously as #{@context_shape[key]} and now as #{type}"
      end
    end
  end
end
