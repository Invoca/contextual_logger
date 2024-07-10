# frozen_string_literal: true

lib = File.expand_path("../lib", __FILE__)
$LOAD_PATH.unshift(lib) unless $LOAD_PATH.include?(lib)
require "contextual_logger/version"

Gem::Specification.new do |spec|
  spec.name        = 'contextual_logger'
  spec.version     = ContextualLogger::VERSION
  spec.license     = 'MIT'
  spec.summary     = 'Add context to your logger'
  spec.description = 'A way to add context to the logs you have'
  spec.authors     = ['James Ebentier']
  spec.email       = 'jebentier@invoca.com'
  spec.files       = Dir['lib/**/*']
  spec.homepage    = 'https://rubygems.org/gems/contextual_logger'
  spec.metadata    = {
    "source_code_uri"   => "https://github.com/Invoca/contextual_logger",
    "allowed_push_host" => "https://rubygems.org"
  }

  spec.add_dependency 'json'
  spec.add_dependency 'activesupport', ">= 6.0"
end
