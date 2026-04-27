import { describe, it, expect } from 'vitest';
import { tokenize } from './tokenizer';

describe('tokenize', () => {
  it('tokenizes a simple command', () => {
    const toks = tokenize('echo hello');
    expect(toks.map((t) => t.type)).toEqual(['WORD', 'WORD', 'EOF']);
    expect(toks[0].value).toBe('echo');
    expect(toks[1].value).toBe('hello');
  });

  it('preserves single-quoted content literally', () => {
    const toks = tokenize("echo 'a b $c'");
    expect(toks[1].segments).toEqual([{ type: 'single_quoted', value: 'a b $c' }]);
  });

  it('captures double-quoted content with expansion pending', () => {
    const toks = tokenize('echo "a $b c"');
    expect(toks[1].segments).toEqual([{ type: 'double_quoted', value: 'a $b c' }]);
  });

  it('handles escape inside double quotes', () => {
    const toks = tokenize('echo "it\\"s"');
    expect(toks[1].segments).toEqual([{ type: 'double_quoted', value: 'it"s' }]);
  });

  it('preserves literal backslash in double quotes for non-special chars', () => {
    const toks = tokenize('echo "a\\nb"');
    expect(toks[1].segments).toEqual([{ type: 'double_quoted', value: 'a\\nb' }]);
  });

  it('unquoted backslash escapes next char', () => {
    const toks = tokenize('echo hello\\ world');
    // "hello\ world" should become a single word "hello world"
    expect(toks).toHaveLength(3);
    expect(toks[1].type).toBe('WORD');
    expect(toks[1].segments).toEqual([
      { type: 'literal', value: 'hello world' },
    ]);
  });

  it('concatenates adjacent quoted and unquoted parts into one word', () => {
    const toks = tokenize('echo foo"bar"baz');
    expect(toks).toHaveLength(3);
    expect(toks[1].segments).toEqual([
      { type: 'literal', value: 'foo' },
      { type: 'double_quoted', value: 'bar' },
      { type: 'literal', value: 'baz' },
    ]);
  });

  it('handles line continuation (joins across newline)', () => {
    // Bash behaviour: `echo hello\<newline>world` → `echo helloworld`
    const toks = tokenize('echo hello\\\nworld');
    expect(toks.map((t) => t.value)).toEqual(['echo', 'helloworld', '']);
  });

  it('treats # as comment at word boundary', () => {
    const toks = tokenize('echo hello # this is a comment\nls');
    const types = toks.map((t) => t.type);
    expect(types).toEqual(['WORD', 'WORD', 'NEWLINE', 'WORD', 'EOF']);
  });

  it('does NOT treat # as comment mid-word', () => {
    const toks = tokenize('echo foo#bar');
    // foo#bar should be a single word.
    expect(toks[1].value).toBe('foo#bar');
  });

  it('recognizes && and || as operators', () => {
    const toks = tokenize('a && b || c');
    expect(toks.map((t) => ({ t: t.type, v: t.value }))).toEqual([
      { t: 'WORD', v: 'a' },
      { t: 'OPERATOR', v: '&&' },
      { t: 'WORD', v: 'b' },
      { t: 'OPERATOR', v: '||' },
      { t: 'WORD', v: 'c' },
      { t: 'EOF', v: '' },
    ]);
  });

  it('recognizes pipe and background separately', () => {
    const toks = tokenize('a | b & c');
    expect(toks.map((t) => t.value)).toEqual(['a', '|', 'b', '&', 'c', '']);
  });

  it('recognizes semicolon and double-semicolon', () => {
    const toks = tokenize('a ;; b ; c');
    expect(toks.map((t) => t.value)).toEqual(['a', ';;', 'b', ';', 'c', '']);
  });

  it('recognizes newlines as separate tokens', () => {
    const toks = tokenize('a\nb');
    expect(toks.map((t) => ({ t: t.type, v: t.value }))).toEqual([
      { t: 'WORD', v: 'a' },
      { t: 'NEWLINE', v: '\n' },
      { t: 'WORD', v: 'b' },
      { t: 'EOF', v: '' },
    ]);
  });

  it('recognizes redirection operators', () => {
    const toks = tokenize('cmd > out >> log < in');
    const types = toks.map((t) => t.value);
    expect(types).toEqual(['cmd', '>', 'out', '>>', 'log', '<', 'in', '']);
  });

  it('recognizes 2>&1 as IO_NUMBER + >& + WORD', () => {
    const toks = tokenize('echo hi 2>&1');
    expect(toks.map((t) => ({ t: t.type, v: t.value }))).toEqual([
      { t: 'WORD', v: 'echo' },
      { t: 'WORD', v: 'hi' },
      { t: 'IO_NUMBER', v: '2' },
      { t: 'OPERATOR', v: '>&' },
      { t: 'WORD', v: '1' },
      { t: 'EOF', v: '' },
    ]);
  });

  it('recognizes 2>file as IO_NUMBER + > + WORD', () => {
    const toks = tokenize('echo hi 2>err.log');
    expect(toks.map((t) => ({ t: t.type, v: t.value }))).toEqual([
      { t: 'WORD', v: 'echo' },
      { t: 'WORD', v: 'hi' },
      { t: 'IO_NUMBER', v: '2' },
      { t: 'OPERATOR', v: '>' },
      { t: 'WORD', v: 'err.log' },
      { t: 'EOF', v: '' },
    ]);
  });

  it('captures $VAR as a dollar segment', () => {
    const toks = tokenize('echo $HOME');
    expect(toks[1].segments).toEqual([{ type: 'dollar', value: '$HOME' }]);
  });

  it('captures ${VAR} as a dollar segment', () => {
    const toks = tokenize('echo ${HOME}/bin');
    expect(toks[1].segments).toEqual([
      { type: 'dollar', value: '${HOME}' },
      { type: 'literal', value: '/bin' },
    ]);
  });

  it('captures $(cmd) as a dollar segment', () => {
    const toks = tokenize('echo $(pwd)/foo');
    expect(toks[1].segments).toEqual([
      { type: 'dollar', value: '$(pwd)' },
      { type: 'literal', value: '/foo' },
    ]);
  });

  it('captures nested $(...) correctly', () => {
    const toks = tokenize('echo $(echo $(pwd))');
    expect(toks[1].segments).toEqual([
      { type: 'dollar', value: '$(echo $(pwd))' },
    ]);
  });

  it('captures $(( )) arithmetic', () => {
    const toks = tokenize('echo $((1 + 2))');
    expect(toks[1].segments).toEqual([
      { type: 'dollar', value: '$((1 + 2))' },
    ]);
  });

  it('captures backticks as equivalent of $(...)', () => {
    const toks = tokenize('echo `pwd`');
    expect(toks[1].segments).toEqual([{ type: 'dollar', value: '$(pwd)' }]);
  });

  it('preserves $ in single quotes literally', () => {
    const toks = tokenize("echo '$HOME'");
    expect(toks[1].segments).toEqual([{ type: 'single_quoted', value: '$HOME' }]);
  });

  it('expands $ inside double quotes into a dollar segment', () => {
    const toks = tokenize('echo "foo $BAR baz"');
    // Double-quoted segment stays intact; the expander handles the inner $.
    expect(toks[1].segments).toEqual([
      { type: 'double_quoted', value: 'foo $BAR baz' },
    ]);
  });

  it('handles empty double-quoted string as a present (but empty) arg', () => {
    const toks = tokenize('echo "" done');
    expect(toks.map((t) => t.type)).toEqual(['WORD', 'WORD', 'WORD', 'EOF']);
    expect(toks[1].segments).toEqual([{ type: 'double_quoted', value: '' }]);
  });

  it('throws on unterminated single quote', () => {
    expect(() => tokenize("echo 'hello")).toThrow(/unterminated single quote/);
  });

  it('throws on unterminated double quote', () => {
    expect(() => tokenize('echo "hello')).toThrow(/unterminated double quote/);
  });

  it('throws on unterminated $(', () => {
    expect(() => tokenize('echo $(pwd')).toThrow(/unterminated \$/);
  });
});
