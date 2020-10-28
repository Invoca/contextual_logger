# frozen_string_literal: true

require 'contextual_logger'

def itShouldDedupRegistry(&block)
  context 'when defining duplicate keys' do
    it 'raises a DuplicateDefinitionError' do
      expect { described_class.new(&block) }.to raise_error(ContextualLogger::Context::Registry::DuplicateDefinitionError)
    end
  end
end

RSpec.describe ContextualLogger::Context::Registry do
  let(:registry) { described_class.new {} }

  context '#strict?' do
    subject { registry.strict? }

    context 'when defined with an empty block' do
      it { should be_truthy }
    end

    context 'when defined in the registry configuration as true' do
      let(:registry) { described_class.new { strict true } }
      it { should be_truthy }
    end

    context 'when defined in the registry configuration as false' do
      let(:registry) { described_class.new { strict false } }
      it { should be_falsey }
    end
  end

  context '#context_shape' do
    let(:expected_context_shape) { {} }
    subject { registry.context_shape }

    context 'when defined with an empty block' do
      it { should be_empty }
    end

    context 'when defining strings' do
      context 'when defining a context entry' do
        let(:registry) do
          described_class.new do
            string :test_context
          end
        end

        let(:expected_context_shape) do
          { test_context: { type: :string, formatter: :to_s } }
        end

        it { should eq(expected_context_shape)}
      end

      itShouldDedupRegistry do
        string :test_context
        string :test_context
      end
    end

    context 'when defining booleans' do
      context 'when defining a context entry' do
        let(:registry) do
          described_class.new do
            boolean :test_context
          end
        end

        let(:expected_context_shape) do
          { test_context: hash_including({ type: :boolean }) }
        end

        it { should include(expected_context_shape)}
      end

      itShouldDedupRegistry do
        boolean :test_context
        boolean :test_context
      end
    end

    context 'when defining numbers' do
      context 'when defining a context entry' do
        let(:registry) do
          described_class.new do
            number :test_context
          end
        end

        let(:expected_context_shape) do
          { test_context: { type: :number, formatter: :to_i } }
        end

        it { should eq(expected_context_shape)}
      end

      itShouldDedupRegistry do
        number :test_context
        number :test_context
      end
    end

    context 'when defining dates' do
      context 'when defining a context entry' do
        let(:registry) do
          described_class.new do
            date :test_context
          end
        end

        let(:expected_context_shape) do
          { test_context: hash_including({ type: :date }) }
        end

        it { should include(expected_context_shape)}
      end

      itShouldDedupRegistry do
        date :test_context
        date :test_context
      end
    end

    context 'when defining a hash' do
      itShouldDedupRegistry do
        hash :test_context do
          string :test_sub_context
        end

        hash :test_context do
          string :test_sub_context
        end
      end

      context 'when defining a context entry' do
        let(:registry) do
          described_class.new do
            hash :test_context do
              string :test_sub_context
            end
          end
        end

        let(:expected_context_shape) do
          {
            test_context: {
              test_sub_context: {
                type: :string,
                formatter: :to_s
              }
            }
          }
        end

        it { should eq(expected_context_shape)}
      end

      context 'when defining nested context entries' do
        let(:registry) do
          described_class.new do
            hash :test_context do
              string :test_sub_context
              hash :test_sub_context_hash do
                number :test_sub_context_number
              end
            end
          end
        end

        let(:expected_context_shape) do
          {
            test_context: {
              test_sub_context: {
                type: :string,
                formatter: :to_s
              },
              test_sub_context_hash: {
                test_sub_context_number: {
                  type: :number,
                  formatter: :to_i
                }
              }
            }
          }
        end

        it { should eq(expected_context_shape)}
      end
    end
  end
end
