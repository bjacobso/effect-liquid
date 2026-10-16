# Static Ripper extraction only. Never require or evaluate upstream test files.
require 'ripper'
require 'json'
require 'bigdecimal'
class Unresolved < StandardError; end
class Extractor
  def initialize(text, repository = nil)
    @repository=repository; @text=text; @fixtures=[]; @inventory=[]; @seen={}; @quotes={}; stack=[]
    Ripper.lex(text).each do |pos,event,value,_|
      case event
      when :on_tstring_beg, :on_heredoc_beg then stack << value
      when :on_tstring_end, :on_heredoc_end then stack.pop
      when :on_tstring_content then @quotes[pos]=stack.last
      end
    end
  end
  def decode(text,quote)
    return text.gsub(/\\([\\'])/,'\1') if quote && (quote=="'" || quote.include?("<<'"))
    text.gsub(/\\(?:u\{[0-9a-fA-F ]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.|\n)/m) do |escape|
      code=escape[1..-1]
      case code
      when 'n' then "\n"
      when 'r' then "\r"
      when 't' then "\t"
      when 'f' then "\f"
      when 'v' then "\v"
      when 'b' then "\b"
      when 'a' then "\a"
      when 'e' then "\e"
      when 's' then ' '
      when "\n" then ''
      else
        if code.start_with?('u{') then code[2..-2].split.map{|x|x.to_i(16)}.pack('U*')
        elsif code.start_with?('u') then [code[1..-1].to_i(16)].pack('U')
        elsif code.start_with?('x') then [code[1..-1].to_i(16)].pack('C').force_encoding('UTF-8')
        elsif code =~ /\A[0-7]+\z/ then [code.to_i(8)].pack('C').force_encoding('UTF-8')
        else code end
      end
    end
  end
  def value(n,env)
    return nil if n.nil?
    raise Unresolved,'Invalid value AST' unless n.is_a?(Array)
    case n[0]
    when :@int then Integer(n[1])
    when :@float then Float(n[1])
    when :var_ref,:vcall
      token=n[1];return {'nil'=>nil,'true'=>true,'false'=>false}[token[1]] if token[0]==:@kw
      raise Unresolved,"Unresolved variable: #{token[1]}" unless env.key?(token[1])
      v=env[token[1]];raise v if v.is_a?(Unresolved);v
    when :string_literal then value(n[1],env)
    when :string_content then n[1..-1].map{|part|value(part,env)}.join
    when :@tstring_content then decode(n[1],@quotes[n[2]])
    when :string_concat then value(n[1],env)+value(n[2],env)
    when :symbol_literal then n[1][1][1].to_sym
    when :dot2,:dot3 then Range.new(value(n[1],env),value(n[2],env),n[0]==:dot3)
    when :@label then n[1][0..-2].to_sym
    when :array then (n[1]||[]).map{|a|value(a,env)}
    when :hash then pairs(n[1] ? n[1][1] : [],env)
    when :bare_assoc_hash then pairs(n[1],env)
    when :unary then n[1]==:-@ ? -value(n[2],env) : (raise Unresolved,'Unsupported unary operator')
    when :paren then value(n[1][0],env)
    when :binary
      a=value(n[1],env);b=value(n[3],env)
      case n[2];when :+ then a+b;when :- then a-b;when :* then raise Unresolved,'Large repeated fixture' if b.is_a?(Numeric)&&b>10000;a*b;else raise Unresolved,'Unsupported arithmetic';end
    when :aref then value(n[1],env).fetch(arguments(n[2]).map{|a|value(a,env)}[0])
    when :call
      receiver=value(n[1],env);name=n[3][1]
      case name;when 'freeze' then receiver;when 'to_s' then receiver.to_s;when 'strip' then receiver.strip;else raise Unresolved,"Unsupported call: #{name}";end
    when :method_add_arg,:command
      c=call(n);raise Unresolved,"Unsupported constructor" unless c && c[0][1]=="BigDecimal"
      BigDecimal(value(arguments(c[1])[0],env))
    else raise Unresolved,"Unsupported value: #{n[0]}"
    end
  end
  def pairs(items,env)
    (items||[]).each_with_object({}) do |p,out|
      raise Unresolved,'Hash splat or nonliteral association' unless p[0]==:assoc_new
      key=value(p[1],env);raise Unresolved,'Non-string hash key' unless key.is_a?(String) || key.is_a?(Symbol)
      raise Unresolved,'Duplicate hash key' if out.key?(key)
      out[key]=value(p[2],env)
    end
  end
  def arguments(n)
    return [] if n.nil?
    return arguments(n[1]) if n[0]==:arg_paren
    raise Unresolved,'Splat or block arguments' unless n[0]==:args_add_block && !n[2]
    n[1]||[]
  end
  def call(n)
    return nil unless n.is_a?(Array)
    if n[0]==:command then [n[1],n[2]]
    elsif n[0]==:method_add_arg && n[1][0]==:fcall then [n[1][1],n[2]]
    end
  end
  def encode(v, depth = 0)
    raise Unresolved,"Cyclic or deeply nested host value" if depth > 128
    case v
    when Integer then {'$liquid'=>{type:'integer',value:v.to_s}}
    when Float then {'$liquid'=>{type:'float',value:v.to_s}}
    when BigDecimal then {'$liquid'=>{type:'decimal',value:v.to_s('F')}}
    when Symbol then {'$liquid'=>{type:'symbol',value:v.to_s}}
    when Range then {'$liquid'=>{type:'range',from:encode(v.begin,depth+1),to:encode(v.end,depth+1),exclusive:v.exclude_end?}}
    when Array then v.map{|x|encode(x,depth+1)}
    when Hash
      if v.keys.any?{|k| k.is_a?(Symbol)}
        {'$liquid'=>{type:'hash',entries:v.map{|k,x|[encode(k,depth+1),encode(x,depth+1)]}}}
      else v.transform_values{|x|encode(x,depth+1)} end
    else v
    end
  end
  def capture(n,env,forced_reason=nil)
    c=call(n);return unless c && ['assert_template_result','assert_template_result_matches'].include?(c[0][1])
    line,column=c[0][2];key="#{line}:#{column}";return if @seen[key];@seen[key]=true
    base={line:line,column:column,call:c[0][1]}
    begin
      raise Unresolved,forced_reason if forced_reason
      args=arguments(c[1]);expected=value(args[0],env);source=value(args[1],env);third=args[2] ? value(args[2],env) : {}
      keywords=@repository!='ruby-liquid' && args[2] && args[2][0]==:bare_assoc_hash && third.keys.all?{|k| k.is_a?(Symbol)}
      context=keywords ? {} : third;templates=(@stub_templates || {}).dup;extra_node=args[3] || (args[2] if keywords)
      if extra_node
        extra=value(extra_node,env)
        extra=extra.transform_keys(&:to_s) if extra.is_a?(Hash)
        if extra.is_a?(Hash)
          raise Unresolved,'Unsupported assertion setup/options' unless (extra.keys-['partials','message','error_mode','render_errors']).empty?
          templates.merge!(extra['partials']||{})
          upstream_options={errorMode:extra['error_mode']&.to_s,renderErrors:extra['render_errors']}
          raise Unresolved,'Inline rendered-error semantics require an adapter' if extra['render_errors']
        elsif !extra.is_a?(String) && !extra.nil? then raise Unresolved,'Unsupported assertion options' end
      end
      raise Unresolved,'Expected output/template must be strings' unless expected.is_a?(String)&&source.is_a?(String)
      raise Unresolved,'Context must be a record' unless context.is_a?(Hash)
      if @stub_fallback
        texts=[source,*templates.values]
        texts.each{|text|text.scan(/\{%\s*(?:include|render)\s+['"]([^'"]+)['"]/).each{|name|templates[name[0]] ||= name[0]}}
        walk_values=lambda{|v|if v.is_a?(Hash);v.each_value{|x|walk_values.call(x)};elsif v.is_a?(Array);v.each{|x|walk_values.call(x)};elsif v.is_a?(String);templates[v] ||= v;end}
        walk_values.call(context)
      end
      fixture=base.merge(upstreamOptions:upstream_options || {},source:source,context:encode(context),templates:templates,expected:{kind:'output',output:expected},operation:'render')
      if @repository == 'shopify-liquid'
        fixture[:globals]=fixture[:context];fixture[:context]={}
      end
      JSON.generate(fixture) # Reject invalid Unicode/nonfinite values rather than changing them.
      @fixtures << JSON.parse(JSON.generate(fixture));@inventory << base.merge(status:'imported')
    rescue Unresolved,JSON::GeneratorError,JSON::NestingError,KeyError,TypeError,ArgumentError => error
      @inventory << base.merge(status:'excluded',reason:error.message)
    end
  end
  def statements(list,env)
    (list||[]).each do |n|
      next unless n.is_a?(Array)
      if n[0]==:assign && n[1][0]==:var_field
        name=n[1][1][1];begin;env[name]=value(n[2],env);rescue Unresolved,KeyError,TypeError,ArgumentError=>e;env[name]=Unresolved.new(e.message);end
      elsif n[0]==:assign && n[1][0]==:aref_field
        begin;object=value(n[1][1],env);key=value(arguments(n[1][2])[0],env);object[key]=value(n[2],env);rescue Unresolved,KeyError,TypeError,ArgumentError;end
      else capture(n,env) end
    end
  end
  def walk(n,&block)
    return unless n.is_a?(Array)
    yield n
    n.each{|child|walk(child,&block) if child.is_a?(Array)}
  end
  def run
    tree=Ripper.sexp(@text)
    return {fixtures:[],inventory:[{line:1,column:0,status:'excluded',reason:'Ruby syntax unsupported by installed Ripper'}]} unless tree
    @stub_templates={}
    if @repository=='ruby-liquid' && @text.include?('Liquid::Template.file_system = TestFileSystem.new')
      walk(tree) do |n|
        next unless n[0]==:class && n[1][0]==:const_ref && n[1][1][1]=='TestFileSystem'
        walk(n) do |method|
          next unless method[0]==:def && method[1][1]=='read_template_file'
          branch=method[3][1]&.first
          next unless branch && branch[0]==:case
          arm=branch[2]
          while arm && arm[0]==:when
            begin
              template=value(arm[2]&.last,{})
              arm[1].each{|key|name=value(key,{});@stub_templates[name]=template if name.is_a?(String)&&template.is_a?(String)}
            rescue Unresolved;end
            arm=arm[3]
          end
          @stub_fallback=arm && arm[0]==:else && arm[1]&.first&.dig(0)==:var_ref
        end
      end
    end
    walk(tree) do |n|
      if n[0]==:def && n[1][1].start_with?('test_')
        statements(n[3][1],{})
      end
    end
    walk(tree){|n|capture(n,{},'Assertion requires unsupported surrounding control flow/setup')}
    {fixtures:@fixtures,inventory:@inventory}
  end
end
input=JSON.parse(STDIN.read)
output=input.map{|entry|{path:entry['path'],result:Extractor.new(File.read(entry['absolute']),entry['repository']).run}}
STDOUT.write(JSON.generate(output))
