# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name        = 'contextual_logger'
  spec.version     = '0.4.pre.2'
  spec.license     = 'MIT'
  spec.date        = '2018-10-12'
  spec.summary     = 'Add context to your logger'
  spec.description = 'A way to add context to the logs you have'
  spec.authors     = ['James Ebentier']
  spec.email       = 'jebentier@invoca.com'
  spec.files       = Dir['lib/**/*']
  spec.homepage    = 'https://rubygems.org/gems/contextual_logger'
  spec.metadata    = {
    "source_code_uri"   => "https://github.com/Invoca/process_settings",
    "allowed_push_host" => "https://rubygems.org"
  }

  spec.add_runtime_dependency 'json'
  spec.add_runtime_dependency 'activesupport'
end
