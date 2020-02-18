# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

describe ContextualLogger::Context::Handler do
  let(:context) { { service: "hello_world", integration: "google" } }
  subject(:handler) { ContextualLogger::Context::Handler.new(context) }

  it { is_expected.to respond_to(:set!) }
  it { is_expected.to respond_to(:reset!) }

  it 'sets the thread context on set!' do
    previous_context = ContextualLogger::Context::Handler.current_context
    handler.set!

    expect(ContextualLogger::Context::Handler.current_context).to_not eq(previous_context)
    expect(ContextualLogger::Context::Handler.current_context).to eq(context)

    handler.reset!
  end

  it 'resets the thread context on reset!' do
    initial_context = ContextualLogger::Context::Handler.current_context
    handler.set!
    new_context = ContextualLogger::Context::Handler.current_context
    handler.reset!

    expect(ContextualLogger::Context::Handler.current_context).to_not eq(new_context)
    expect(ContextualLogger::Context::Handler.current_context).to eq(initial_context)
  end
end
