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
    describe 'current_context/current_context=' do
      it 'can be set with current_context=, separately per Fiber/Thread' do
        instance.current_context = context

        thread =
          Thread.new do
            instance.current_context = context2
            expect(instance.current_context({})).to eq(context2)
          end

        fiber =
          Fiber.new do
            instance.current_context = context3
            expect(instance.current_context({})).to eq(context3)
          end

        fiber.resume
        thread.join

        expect(instance.current_context({})).to eq(context)
      end

      it 'the current_context= values are separate per containing instance' do
        instance.current_context = context
        instance2 = ContextualLoggerContextSpecContainer.new
        instance2.current_context = context2

        expect(instance.current_context({})).to eq(context)
        expect(instance2.current_context({})).to eq(context2)
      end

      it 'defaults to global_context when set to nil' do
        instance.current_context = nil

        expect(instance.current_context(context)).to eq(context)
      end
    end
  end
end
