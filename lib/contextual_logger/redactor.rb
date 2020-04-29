# frozen_string_literal: true

module ContextualLogger
  class Redactor
    attr_reader :redaction_set, :redaction_regex

    REDACTED_STRING = '******'

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
          log_entry.reduce({}) do |redacted_log_entry, (key, value)|
            redacted_log_entry[key] = redact(value)
            redacted_log_entry
          end
        when Array
          log_entry.map { |value| redact(value) }
        when true, false
          log_entry
        else
          log_entry_string = log_entry.to_s
          if log_entry_string.match?(redaction_regex)
            log_entry_string.to_s.gsub(redaction_regex, REDACTED_STRING)
          else
            log_entry_string
          end
        end
      else
        log_entry
      end
    end
  end
end
