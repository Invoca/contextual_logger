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

  describe '#reset!'
    before  { instance.current_context_override = context2 }

    it { expect { hander.reset! }.to change(instance, :current_context_override).from(context2).to(context) }
  end
end
