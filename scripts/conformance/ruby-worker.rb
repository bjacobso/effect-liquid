require 'json'
require 'rubygems'
require 'fiddle'
require 'time'
# Kill the oracle when its supervising worker is killed, including on timeout.
parent = Process.ppid
if RUBY_PLATFORM.include?('linux')
  Fiddle::Function.new(Fiddle.dlopen(nil)['prctl'], [Fiddle::TYPE_INT, *([Fiddle::TYPE_LONG]*4)], Fiddle::TYPE_INT).call(1,9,0,0,0)
  exit! if Process.ppid != parent
else
  Thread.new { loop { sleep 0.1; exit! if Process.ppid != parent } }
end
Process.setrlimit(Process::RLIMIT_AS,256*1024*1024,256*1024*1024) if Process.const_defined?(:RLIMIT_AS)
home=File.expand_path('../../.cache/ruby-gems',__dir__)
Gem.use_paths(home,[home,*Gem.default_path])
gem 'strscan','=3.1.1'
gem 'bigdecimal','=3.1.3'
pin=JSON.parse(File.read(File.join(home,'oracle-pin.json')))
gem 'liquid',"=#{pin['version']}"
require 'liquid'
require 'bigdecimal'
class << Time
  alias_method :oracle_now, :now
  attr_accessor :fixture_clock
  def now
    fixture_clock || oracle_now
  end
end
STDOUT.sync=true
class MemoryFiles
  def initialize(files,spec)
    @files=files;@spec=spec
  end
  def key(name)
    return name unless @spec
    name=name.downcase
    name.end_with?('.liquid') ? name : name+'.liquid'
  end
  def read_template_file(name)
    pair=@files.find{|k,_|key(k)==key(name)}
    raise Liquid::FileSystemError,"Template not found: #{name}" unless pair
    pair[1]
  end
end
def decode(v)
  case v
  when Array then v.map{|x|decode(x)}
  when Hash
    if v.keys==['$liquid']
      t=v['$liquid']
      case t['type']
      when 'integer' then Integer(t['value'])
      when 'float' then Float(t['value'])
      when 'decimal' then BigDecimal(t['value'])
      when 'symbol' then t['value'].to_sym
      when 'range' then Range.new(decode(t['from']),decode(t['to']),t['exclusive'])
      when 'hash' then t['entries'].map{|k,x|[decode(k),decode(x)]}.to_h
      else raise "Unknown fixture value tag"
      end
    else v.transform_values{|x|decode(x)} end
  else v
  end
end
def execute(f)
  phase='parse'
  Time.fixture_clock=nil
  Time.fixture_clock=Time.iso8601(f['clock']) if f['clock']
  options=f['options']||{}
  unsupported=options.keys & ['memoryLimit','renderLimit','parseLimit','keepOutputType']
  return {kind:'unsupported-configuration',options:unsupported} unless unsupported.empty?
  files=MemoryFiles.new((options['templates']||{}).merge(f['templates']||{}),f.dig('origin','repository')=='liquid-spec')
  mode=f.dig('upstreamOptions','errorMode')||'strict'
  mode='strict' unless ['lax','strict','strict2'].include?(mode)
  environment=Liquid::Environment.build(file_system:files,error_mode:mode.to_sym) { |env| env.default_resource_limits={render_length_limit:2_000_000,render_score_limit:100_000,assign_score_limit:100_000} }
  template=Liquid::Template.parse(f['source'],environment:environment,error_mode:mode.to_sym,line_numbers:true)
  return {kind:'parsed'} if f['operation']=='parse'
  phase='render'
  legacy=f.dig('origin','repository')=='ruby-liquid'
  context=Liquid::Context.build(environment:environment,environments:legacy ? decode(f['context']||{}) : {},static_environments:decode(f['globals']||options['globals']||{}).merge(legacy ? {} : decode(f['context']||{})),registers:{file_system:files},rethrow_errors:true)
  context.strict_variables=options['strictVariables']||false
  context.strict_filters=options['strictFilters']||false
  result=template.render!(context)
  raise Liquid::MemoryError,'Harness output exceeds 2 MB' if result.bytesize>2_000_000
  {kind:'output',output:result}
rescue StandardError => e
  {kind:'error',phase:phase,name:e.class.name.split('::').last,message:e.message}
end
puts JSON.generate({ready:true})
STDIN.each_line do |line|
  m=JSON.parse(line)
  puts JSON.generate({id:m['id'],result:execute(m['fixture'])})
end
