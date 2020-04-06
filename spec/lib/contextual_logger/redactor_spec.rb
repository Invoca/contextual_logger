# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

RSpec.describe ContextualLogger::Redactor do
  subject { described_class.new }

  describe '#match' do
    it 'adds the new sensitive data to the redaction set' do
      expect(subject.redaction_set).to be_empty
      subject.match('hello')
      expect(subject.redaction_set).to include('hello')
    end

    it 'adds the same string only once' do
      expect(subject.redaction_set).to be_empty

      subject.match('hello')
      expect(subject.redaction_set.to_a).to eq(['hello'])

      subject.match('hello')
      expect(subject.redaction_set.to_a).to eq(['hello'])
    end
  end

  describe '#redact' do
    before(:each) { subject.match('hello') }

    it 'redacts the sensitive data from the message' do
      expect(subject.redact('hello world')).to eq('<redacted> world')
    end

    describe 'with multiple strings' do
      before(:each) { subject.match('world') }

      it 'redacts all sensitive data from the message' do
        expect(subject.redact('hello world')).to eq('<redacted> <redacted>')
      end
    end
  end
end
