# frozen_string_literal: true

module ActiveSupport
  module TaggedLogging
    module Formatter
      def call(severity, timestamp, progname, msg)
        msg_with_tags = case msg
                        when Hash
                          msg.merge(log_tags: current_tags.join(', '))
                        else
                          "#{tags_text}#{msg}"
                        end

        super(severity, timestamp, progname, msg_with_tags)
      end
    end
  end
end
