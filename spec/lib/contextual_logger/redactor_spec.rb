# frozen_string_literal: true

require 'spec_helper'
require 'contextual_logger'

RSpec.describe ContextualLogger::Redactor do
  subject { described_class.new }

  describe '#register_secret' do
    it 'adds the new sensitive data to the redaction set' do
      expect(subject.redaction_set).to be_empty
      subject.register_secret('hello')
      expect(subject.redaction_set).to include('hello')
    end

    it 'adds the same string only once' do
      expect(subject.redaction_set).to be_empty

      subject.register_secret('hello')
      expect(subject.redaction_set.to_a).to eq(['hello'])

      subject.register_secret('hello')
      expect(subject.redaction_set.to_a).to eq(['hello'])
    end
  end

  describe '#redact' do
    before(:each) do
      subject.register_secret_regex('(key|password|token|secret)[_a-z]*[\s\"]*(:|=>|=)[\s\"]*\K([0-9a-zA-Z_]*)')
      subject.register_secret('hello')
    end

    it 'redacts the sensitive data from the message' do
      expect(subject.redact('api_key=ffbba9b905c0a549b48f48894ad7aa9b7bd7c06c world')).to eq('api_key=<redacted> world')
    end

    it 'redacts registered secrets from the message' do
      expect(subject.redact('hello world')).to eq('<redacted> world')
    end

    describe 'with multiple strings' do
      before(:each) { subject.register_secret('world') }

      it 'redacts all sensitive data from the message' do
        expect(subject.redact('hello world')).to eq('<redacted> <redacted>')
      end
    end
  end

  describe '#register_redacted_key' do
    it 'adds the new key to redacted_keys' do
      expect(subject.redacted_keys).to be_empty
      subject.register_redacted_key(:exchanges)
      expect(subject.redacted_keys).to include('exchanges')
    end

    it 'adds the same key only once when registered repeatedly as the same type' do
      subject.register_redacted_key(:exchanges)
      expect(subject.redacted_keys.to_a).to eq(['exchanges'])

      subject.register_redacted_key(:exchanges)
      expect(subject.redacted_keys.to_a).to eq(['exchanges'])
    end

    it 'dedups a Symbol registration followed by a String registration of the same key' do
      subject.register_redacted_key(:exchanges)
      subject.register_redacted_key('exchanges')
      expect(subject.redacted_keys.to_a).to eq(['exchanges'])
    end

    it 'dedups a String registration followed by a Symbol registration of the same key' do
      subject.register_redacted_key('exchanges')
      subject.register_redacted_key(:exchanges)
      expect(subject.redacted_keys.to_a).to eq(['exchanges'])
    end
  end

  describe '#redact_context' do
    context 'when no keys are registered' do
      it 'returns the exact same hash object, unchanged' do
        context = { user_id: 1, exchanges: 'raw transcript' }
        expect(subject.redact_context(context)).to equal(context)
      end
    end

    context 'with a registered key at the top level' do
      before(:each) { subject.register_redacted_key(:exchanges) }

      it "masks the key's value while leaving sibling keys untouched" do
        context = { user_id: 1, exchanges: 'raw transcript' }
        expect(subject.redact_context(context)).to eq(user_id: 1, exchanges: '<redacted>')
      end
    end

    context 'with a registered key nested below the top level' do
      before(:each) { subject.register_redacted_key(:exchanges) }

      it 'masks the key at depth while leaving the surrounding structure untouched' do
        context = { call: { leg: { exchanges: 'raw transcript', other: 'kept' }, call_id: 'abc' } }
        expect(subject.redact_context(context)).to eq(
          call: { leg: { exchanges: '<redacted>', other: 'kept' }, call_id: 'abc' }
        )
      end
    end

    context 'with a registered key whose value is an array of hashes' do
      before(:each) { subject.register_redacted_key(:exchanges) }

      it 'replaces the entire array value rather than recursing into its elements' do
        context = { exchanges: [{ request: 'req 1' }, { response: 'resp 1' }] }
        expect(subject.redact_context(context)).to eq(exchanges: '<redacted>')
      end

      it 'still finds the registered key nested inside an unmatched array-of-hashes value' do
        context = { items: [{ exchanges: ['raw'] }, { other: 1 }] }
        expect(subject.redact_context(context)).to eq(
          items: [{ exchanges: '<redacted>' }, { other: 1 }]
        )
      end

      it 'masks only the matching hash element in a mixed array, leaving non-hash elements unchanged' do
        context = { items: ['a string', 5, { exchanges: 'x' }] }
        expect(subject.redact_context(context)).to eq(
          items: ['a string', 5, { exchanges: '<redacted>' }]
        )
      end
    end

    context 'when the registered key is absent from the given context' do
      before(:each) { subject.register_redacted_key(:exchanges) }

      it 'returns a hash structurally equivalent to its input' do
        context = { user_id: 1, call: { leg: 'a' } }
        expect(subject.redact_context(context)).to eq(context)
      end
    end

    context 'non-mutation / frozen input safety' do
      before(:each) { subject.register_redacted_key(:exchanges) }

      it 'does not raise when given a deeply frozen context' do
        context = { call: { exchanges: [{ request: 'req' }].freeze, other: 'kept'.freeze }.freeze }.freeze
        expect { subject.redact_context(context) }.not_to raise_error
      end

      it 'does not alter a deeply frozen input' do
        context = { call: { exchanges: [{ request: 'req' }].freeze, other: 'kept'.freeze }.freeze }.freeze
        expected = { call: { exchanges: [{ request: 'req' }], other: 'kept' } }

        subject.redact_context(context)

        expect(context).to eq(expected)
      end

      it 'does not mutate an unfrozen input in place' do
        context = { exchanges: 'raw transcript', user_id: 1 }

        subject.redact_context(context)

        expect(context).to eq(exchanges: 'raw transcript', user_id: 1)
      end
    end

    context 'independence from value-based redaction' do
      it 'does not alter redaction_set/redaction_regex, and leaves #redact unaffected' do
        subject.register_redacted_key(:exchanges)
        subject.redact_context(exchanges: 'x')

        expect(subject.redaction_set).to be_empty
        expect(subject.redaction_regex).to be_nil
        expect(subject.redact('exchanges: something')).to eq('exchanges: something')
      end

      it 'is unaffected by a registered secret, and does not add it to redacted_keys' do
        subject.register_secret('hello')
        subject.register_secret_regex('wor[ld]+')

        expect(subject.redacted_keys).to be_empty
        expect(subject.redact_context(hello: 'hello world')).to eq(hello: 'hello world')
      end
    end
  end
end
