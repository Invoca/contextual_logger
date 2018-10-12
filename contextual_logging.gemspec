Gem::Specification.new do |spec|
  spec.name        = 'contextual_logging'
  spec.version     = '0.1.0'
  spec.date        = '2018-10-12'
  spec.summary     = "Add context to your logging"
  spec.description = "A way to add context to the logs you have"
  spec.authors     = ["James Ebentier"]
  spec.email       = 'jebentier@invoca.com'
  spec.files       = ["lib/contextual_logging.rb"]
  spec.homepage    = 'https://github.com/Invoca/contextual_logging'

  spec.add_dependency 'json'

  spec.add_development_dependency 'bump', '~> 0.6.1'
  spec.add_development_dependency 'pry'
  spec.add_development_dependency 'rspec'
  spec.add_development_dependency 'rspec_junit_formatter'
  spec.add_development_dependency 'rubocop', '0.54.0'
  spec.add_development_dependency 'rubocop-git'
  spec.add_development_dependency 'simplecov'
  spec.add_development_dependency 'simplecov-json'
  spec.add_development_dependency 'simplecov-rcov'
  spec.add_development_dependency 'ruby-prof'
  spec.add_development_dependency 'ruby-prof-flamegraph'
end
