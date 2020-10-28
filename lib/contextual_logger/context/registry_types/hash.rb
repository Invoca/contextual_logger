# frozen_string_literal: true

require_relative 'string'
require_relative 'boolean'
require_relative 'number'
require_relative 'date'

module ContextualLogger
  module Context
    module RegistryTypes
      class Hash
        def initialize(&definitions)
          @definitions = {}

          run(&definitions)
        end

        def to_h
          @definitions.reduce({}) do |shape_hash, (key, value)|
            shape_hash.merge(key => value.to_h)
          end
        end

        private

        def string(context_key, formatter: nil)
          dedup(context_key, :string)
          @definitions[context_key] = RegistryTypes::String.new(formatter: formatter)
        end

        def boolean(context_key, formatter: nil)
          dedup(context_key, :boolean)
          @definitions[context_key] = RegistryTypes::Boolean.new(formatter: formatter)
        end

        def number(context_key, formatter: nil)
          dedup(context_key, :number)
          @definitions[context_key] = RegistryTypes::Number.new(formatter: formatter)
        end

        def date(context_key, formatter: nil)
          dedup(context_key, :date)
          @definitions[context_key] = RegistryTypes::Date.new(formatter: formatter)
        end

        def hash(context_key, &definitions)
          dedup(context_key, :hash)
          @definitions[context_key] = RegistryTypes::Hash.new(&definitions)
        end

        def run(&definitions)
          instance_eval(&definitions)
        end

        def dedup(key, type)
          @definitions.include?(key) and
            raise Registry::DuplicateDefinitionError, "Defining duplicate entry #{key} previously as #{@definitions[key]} and now as #{type}"
        end
      end
    end
  end
end
