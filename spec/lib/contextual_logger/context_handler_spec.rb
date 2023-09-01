# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

class ContextualLoggerContextHandlerSpecContainer
  include ::ContextualLogger::Context
end

RSpec.describe ContextualLogger::ContextHandler do
  let(:context) { { service: { name: 'tts', description: 'TTS' }, integration: "google" } }
  let(:context2) { { service: { description: 'Context 2' }, integration: "google" } }

  let(:instance) { ContextualLoggerContextHandlerSpecContainer.new }

  subject(:handler) { described_class.new(instance, context) }

  it { is_expected.to respond_to(:reset!) }

  it 'resets the thread context on reset!' do
    instance.current_context_override = context2
    handler.reset!

    expect(instance.current_context_override).to eq(context)
  end
end
