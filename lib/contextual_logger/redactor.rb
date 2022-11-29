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

    def register_regex(regex)
      if redaction_set.add?(regex)
        @redaction_regex = Regexp.new(
          redaction_set.to_a.join('|')
        )
      end
    end

    def redact(log_line)
      if redaction_regex
        log_line.gsub(redaction_regex, '<redacted>')
      else
        log_line
      end
    end
  end
end
