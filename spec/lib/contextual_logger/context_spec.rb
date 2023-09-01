# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

class ContextualLoggerContextSpecContainer
  include ::ContextualLogger::Context
end

RSpec.describe ContextualLogger::Context do
  let(:context) { { service: { name: 'tts', description: 'TTS' }, integration: "google" } }
  let(:context2) { { service: { description: 'Context 2' }, integration: "google" } }
  let(:context3) { { service: { name: 'Context 3' } } }

  let(:instance) { ContextualLoggerContextSpecContainer.new }

  describe 'mixin methods' do
    describe 'current_context_override/current_context_override=' do
      it 'can be set with current_context_override=, separately per Fiber/Thread' do
        instance.current_context_override = context

        thread =
          Thread.new do
            instance.current_context_override = context2
            instance.current_context_override
          end

        fiber =
          Fiber.new do
            instance.current_context_override = context3
            instance.current_context_override
          end

        fiber_override = fiber.resume
        thread_override = thread.value

        expect(instance.current_context_override).to eq(context)
        expect(thread_override).to eq(context2)
        expect(fiber_override).to eq(context3)
      end

      it 'the current_context_override= values are separate per containing instance' do
        instance.current_context_override = context
        instance2 = ContextualLoggerContextSpecContainer.new
        instance2.current_context_override = context2

        expect(instance.current_context_override).to eq(context)
        expect(instance2.current_context_override).to eq(context2)
      end

      it 'freezes the context_override when set' do
        instance.current_context_override = {}

        expect do
          instance.current_context_override[:extra] = 'value'
        end.to raise_exception(RuntimeError, /can't modify frozen/)
      end

      it 'returns nil when set to nil' do
        instance.current_context_override = nil

        expect(instance.current_context_override).to be_nil
      end
    end
  end
end
