# frozen_string_literal: true

module ContextualLogging
  class Context
    def initialize(logger, context)
      @logger  = logger
      @context = context
    end

    def respond_to_missing?(method)
      @logger.respond_to?(method)
    end

    def with_context(context)
      @logger.with_context(@context.merge(context))
    end

    private

    KNOWN_LOGGING_METHODS = [
      :trace,
      :debug,
      :info,
      :warn,
      :error,
      :fatal
    ].freeze

    def method_missing(method, *args, &block)
      if respond_to_missing?(method)
        execute_method_on_logger(method, args)
      else
        super
      end
    end

    def execute_method_on_logger(method, args)
      if args.empty?
        @logger.send(method)
      else
        @logger.send(method, args_for_method(method, args))
      end
    end

    def args_for_method(method, args)
      if KNOWN_LOGGING_METHODS.include?(method)
        @context.merge(message: args[0])
      else
        args
      end
    end
  end
end
