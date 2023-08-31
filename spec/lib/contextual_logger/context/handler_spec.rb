# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

RSpec.describe ContextualLogger::Context do
  let(:context) { { service: { name: 'tts', description: 'TTS' }, integration: "google" } }
  let(:context2) { { service: { description: 'Context 2' }, integration: "google" } }
  let(:context3) { { service: { name: 'Context 3' } } }

  class ContextualLoggerContextContainerForSpec
    include ::ContextualLogger::Context
  end

  let(:instance) { ContextualLoggerContextContainerForSpec.new }

  describe 'mixin methods' do
    describe 'current_context/current_context=' do
      it 'can be set with current_context=, per Fiber/Thread' do
        previous_context = instance.current_context({})
        instance.current_context = context

        Thread.new do
          instance.current_context = context2
          expect(instance.current_context({})).to eq(context2)
        end.value

        Fiber.new do
          instance.current_context = context3
          expect(instance.current_context({})).to eq(context3)
        end.resume

        expect(instance.current_context({})).to eq(context)

      ensure
        instance.current_context = previous_context
      end

      it 'defaults to global_context when set to nil' do
        previous_context = instance.current_context(nil)

        instance.current_context = nil

        expect(instance.current_context(context)).to_not eq(previous_context)
        expect(instance.current_context(context)).to eq(context)

      ensure
        instance.current_context = previous_context
      end
    end
  end

  describe ContextualLogger::Context::Handler do
    subject(:handler) { described_class.new(instance, context) }

    it { is_expected.to respond_to(:reset!) }

    it 'resets the thread context on reset!' do
      initial_context = instance.current_context(nil)
      instance.current_context = context2
      handler.reset!

      expect(instance.current_context(nil)).to eq(context)
    ensure
      instance.current_context = initial_context
    end
  end
end
