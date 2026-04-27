/**
 * AST node types for the shell language.
 *
 * This is a pragmatic POSIX-ish subset: it captures the constructs that
 * real users (and AI agents) routinely type, without being a fully
 * faithful sh implementation.
 *
 * Word segments are preserved so that expansion can correctly distinguish
 * quoted from unquoted parts (quoted text is not split and not globbed).
 */

/** A single segment of a word, after tokenization but before expansion. */
export type WordSegment =
  /** Literal text, subject to variable/substitution expansion and glob/split. */
  | { type: 'literal'; value: string }
  /** Double-quoted text: variable expansion happens, but no splitting or globbing. */
  | { type: 'double_quoted'; segments: WordSegment[] }
  /** Single-quoted text: completely literal, no expansion at all. */
  | { type: 'single_quoted'; value: string }
  /** A $VAR or ${VAR} reference. */
  | { type: 'param'; name: string }
  /** $(...) or `...` command substitution. */
  | { type: 'command_substitution'; script: string }
  /** $((...)) arithmetic substitution. */
  | { type: 'arithmetic'; expression: string };

/** A word is a list of segments that concatenate during expansion. */
export interface Word {
  segments: WordSegment[];
}

/** Redirection operators we support. */
export type RedirOp =
  | '>' // stdout overwrite
  | '>>' // stdout append
  | '<' // stdin from file
  | '<<' // heredoc
  | '2>' // stderr overwrite
  | '2>>' // stderr append
  | '&>' // both streams overwrite
  | '>&' // fd dup, e.g. 2>&1 => { op: '>&', fd: 2, targetFd: 1 }
  | '<&'; // fd dup on stdin

/** A single redirection attached to a command. */
export interface Redirection {
  op: RedirOp;
  /** Source fd for > / >> / 2> / etc. Defaults per-op. */
  fd?: number;
  /** Target is usually a filename word, or for >& / <& it's a numeric fd. */
  target: Word | { fd: number };
  /** For heredocs: the body text (already collected verbatim, no expansion). */
  heredocBody?: string;
  /** For heredocs: whether expansion should happen inside the body. */
  heredocExpand?: boolean;
}

export interface SimpleCommand {
  type: 'simple';
  /** Inline variable assignments like `FOO=bar cmd` (optional). */
  assignments: { name: string; value: Word }[];
  /** The command name and its arguments, pre-expansion. */
  words: Word[];
  redirections: Redirection[];
}

export interface Pipeline {
  type: 'pipeline';
  /** True for `!` negated pipelines. */
  negated: boolean;
  commands: Command[];
}

export interface AndOrList {
  type: 'and_or';
  /** The first command. */
  first: Command;
  /** Subsequent commands chained by && or ||. */
  rest: { op: '&&' | '||'; command: Command }[];
}

export interface ForLoop {
  type: 'for';
  variable: string;
  /** If absent, iterate over "$@" (positional params) — we default to []. */
  items?: Word[];
  body: CommandList;
}

export interface WhileLoop {
  type: 'while';
  condition: CommandList;
  body: CommandList;
  until: boolean; // true for `until` loops
}

export interface IfStatement {
  type: 'if';
  condition: CommandList;
  then: CommandList;
  elifs: { condition: CommandList; then: CommandList }[];
  else?: CommandList;
}

export interface CaseStatement {
  type: 'case';
  subject: Word;
  items: {
    patterns: Word[];
    body: CommandList;
  }[];
}

export interface Subshell {
  type: 'subshell';
  body: CommandList;
  redirections: Redirection[];
}

export interface Group {
  type: 'group';
  body: CommandList;
  redirections: Redirection[];
}

/** Any executable construct. */
export type Command =
  | SimpleCommand
  | Pipeline
  | AndOrList
  | ForLoop
  | WhileLoop
  | IfStatement
  | CaseStatement
  | Subshell
  | Group;

/**
 * A sequence of commands separated by `;` or newlines.
 * The top-level script is also a CommandList.
 */
export interface CommandList {
  type: 'list';
  commands: Command[];
}
