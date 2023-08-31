# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

RSpec.describe ContextualLogger::Context do
  let(:context) { { service: { name: 'tts', description: 'TTS' }, integration: "google" } }
  let(:context2) { { service: { description: 'Context 2' }, integration: "google" } }
  let(:context3) { { service: { name: 'Context 3' } } }

  describe 'class methods' do
    describe 'current_context/current_context=' do
      it 'can be set with current_context=, per Fiber/Thread' do
        previous_context = described_class.current_context({})
        described_class.current_context = context

        Thread.new do
          described_class.current_context = context2
          expect(described_class.current_context({})).to eq(context2)
        end.value

        Fiber.new do
          described_class.current_context = context3
          expect(described_class.current_context({})).to eq(context3)
        end.resume

        expect(described_class.current_context({})).to eq(context)

      ensure
        described_class.current_context = previous_context
      end

      it 'defaults to global_context when set to nil' do
        previous_context = described_class.current_context(nil)

        described_class.current_context = nil

        expect(described_class.current_context(context)).to_not eq(previous_context)
        expect(described_class.current_context(context)).to eq(context)

      ensure
        described_class.current_context = previous_context
      end
    end
  end

  describe 'instance methods' do
    subject(:handler) { described_class::Handler.new(context) }

    it { is_expected.to respond_to(:reset!) }

    it 'resets the thread context on reset!' do
      initial_context = described_class.current_context(nil)
      described_class.current_context = context2
      handler.reset!

      expect(described_class.current_context(nil)).to eq(context)
    ensure
      described_class.current_context = initial_context
    end
  end
end
