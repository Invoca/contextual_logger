# frozen_string_literal: true

module ContextualLogger
  class Redactor
    attr_reader :redaction_set, :redaction_regex

    def initialize
      @redaction_set   = Set.new
      @redaction_regex = nil
    end

    def register_secret(sensitive_data)
      if redaction_set.add?(Regexp.escape(sensitive_data))
        @redaction_regex = Regexp.new(
          redaction_set.to_a.join('|')
        )
      end
    end

    def redact(log_entry)
      if redaction_regex
        case log_entry
        when Hash
          log_entry.reduce({}) { |redacted_log_entry, (key, value)| redacted_log_entry.merge(key => redact(value)) }
        when Array
          log_entry.map { |value| redact(value) }
        else
          log_entry.to_s.gsub(redaction_regex, '******')
        end
      else
        log_entry
      end
    end
  end
end
