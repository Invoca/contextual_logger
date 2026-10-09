# frozen_string_literal: true

module ContextualLogger
  class Redactor
    MASK = '<redacted>'

    attr_reader :redaction_set, :redaction_regex, :redacted_keys

    def initialize
      @redaction_set   = Set.new
      @redaction_regex = nil
      @redacted_keys   = Set.new
    end

    def register_secret(sensitive_data)
      register_secret_regex(Regexp.escape(sensitive_data))
    end

    def register_secret_regex(regex)
      if redaction_set.add?(regex)
        @redaction_regex = Regexp.new(
          redaction_set.to_a.join('|')
        )
      end
    end

    # @param log_line [String]
    # @return [String]
    def redact(log_line)
      if redaction_regex
        log_line.gsub(redaction_regex, MASK)
      else
        log_line
      end
    end

    # Registers a context key whose value is always redacted when `redact_context` walks
    # a context hash, regardless of nesting depth or value shape.
    #
    # @param key [Symbol, String] the context key to redact. Symbol and String registrations
    #   of the "same" key name are treated as equivalent (normalized to String internally).
    # @return [void]
    def register_redacted_key(key)
      redacted_keys.add(key.to_s)
    end

    # Returns a new Hash equivalent to `context`, except that every key matching a
    # registered redacted key (see `register_redacted_key`), at any nesting depth, has its
    # value masked. Does not mutate `context` or anything it contains; safe to call with
    # frozen hashes/arrays.
    #
    # @param context [Hash] the context hash to redact (as passed into `write_entry_to_log`'s
    #   `context:` keyword -- i.e. the same shape every other part of this gem already handles).
    # @return [Hash] a new hash with registered keys' values masked.
    def redact_context(context)
      if redacted_keys.empty?
        context
      else
        redact_hash(context)
      end
    end

    private

    def redact_hash(hash)
      hash.each_with_object({}) do |(key, value), result|
        result[key] =
          if redacted_keys.include?(key.to_s)
            MASK
          else
            redact_value(value)
          end
      end
    end

    def redact_value(value)
      case value
      when Hash
        redact_hash(value)
      when Array
        value.map { |element| element.is_a?(Hash) ? redact_hash(element) : element }
      else
        value
      end
    end
  end
end
