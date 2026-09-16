# Static Ripper extraction only. Never require or evaluate upstream test files.
require 'ripper'
require 'json'
class Unresolved < StandardError; end
class Extractor
  def initialize(text)
    @text=text; @fixtures=[]; @inventory=[]; @seen={}; @quotes={}; stack=[]
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
    when :symbol_literal then n[1][1][1]
    when :@label then n[1][0..-2]
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
    else raise Unresolved,"Unsupported value: #{n[0]}"
    end
  end
  def pairs(items,env)
    (items||[]).each_with_object({}) do |p,out|
      raise Unresolved,'Hash splat or nonliteral association' unless p[0]==:assoc_new
      key=value(p[1],env);raise Unresolved,'Non-string hash key' unless key.is_a?(String)
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
  def capture(n,env,forced_reason=nil)
    c=call(n);return unless c && ['assert_template_result','assert_template_result_matches'].include?(c[0][1])
    line,column=c[0][2];key="#{line}:#{column}";return if @seen[key];@seen[key]=true
    base={line:line,column:column,call:c[0][1]}
    begin
      raise Unresolved,forced_reason if forced_reason
      args=arguments(c[1]);expected=value(args[0],env);source=value(args[1],env);context=args[2] ? value(args[2],env) : {};templates={}
      if args[3]
        extra=value(args[3],env)
        if extra.is_a?(Hash)
          raise Unresolved,'Unsupported assertion setup/options' unless (extra.keys-['partials','message']).empty?
          templates=extra['partials']||{}
        elsif !extra.is_a?(String) && !extra.nil? then raise Unresolved,'Unsupported assertion options' end
      end
      raise Unresolved,'Expected output/template must be strings' unless expected.is_a?(String)&&source.is_a?(String)
      raise Unresolved,'Context must be a record' unless context.is_a?(Hash)
      fixture=base.merge(source:source,context:context,templates:templates,expected:{kind:'output',output:expected},operation:'render')
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
output=input.map{|entry|{path:entry['path'],result:Extractor.new(File.read(entry['absolute'])).run}}
STDOUT.write(JSON.generate(output))
