// main.ts is mend, the CLI SPEC.md specifies (MIT). One command-line tool that
// applies the edits AI models write, in four formats, to a tree of text files:
// a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
// patch format, and text-editor tool calls as JSON. It finds the lines an edit
// names at the first of three matching tiers, and changes every file or none.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with that break. */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinParts(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripBoth(s);
}

/** Every 0-based position where O's lines match the file's lines at the tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with its positions. */
function findFirstTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const pos = occurrences(lines, o, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** The first tier with an occurrence at or after `from`, with those positions. */
function findFirstTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const pos = occurrences(lines, o, tier).filter((p) => p >= from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** At tier 2, a new line is re-indented from O's first line to the file's. */
function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One hunk or chunk as a run of operations: context, deleted and added lines. */
type Op = { t: 'ctx' | 'del' | 'add'; text: string };

function opOld(ops: Op[]): string[] {
  return ops.filter((o) => o.t === 'ctx' || o.t === 'del').map((o) => o.text);
}

function opNew(ops: Op[]): string[] {
  return ops.filter((o) => o.t === 'ctx' || o.t === 'add').map((o) => o.text);
}

/**
 * The lines that replace a matched run: context lines are the file's own matched
 * lines, added lines are re-indented at tier 2 and written as they are otherwise.
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const old = opOld(ops);
  const p = old.length > 0 ? leadingWS(old[0]!) : '';
  const f = fileLines.length > pos ? leadingWS(fileLines[pos]!) : '';
  const out: string[] = [];
  let k = 0;
  for (const op of ops) {
    if (op.t === 'ctx') {
      out.push(fileLines[pos + k]!);
      k += 1;
    } else if (op.t === 'del') {
      k += 1;
    } else {
      out.push(tier === 2 ? reindentLine(op.text, p, f) : op.text);
    }
  }
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const parts = fileParts(before);
      const crlf = parts.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = fileParts(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.now.set(p, joinParts(parts));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A unified hunk: its old start, its operations, and whether a `\` line follows its last context or `+` line. */
interface Hunk {
  a: number;
  ops: Op[];
  bsAfterLast: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return '';
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** One hunk body: the lines after the header that start with ` `, `-`, `+`, `\`, or are empty. */
function parseHunkBody(lines: string[], i: number): { ops: Op[]; bsAfterLast: boolean; next: number } {
  const ops: Op[] = [];
  const idx: number[] = [];
  const bsAt: number[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === '') {
      ops.push({ t: 'ctx', text: '' });
      idx.push(j);
      j += 1;
    } else if (l[0] === ' ') {
      ops.push({ t: 'ctx', text: l.slice(1) });
      idx.push(j);
      j += 1;
    } else if (l[0] === '-') {
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      ops.push({ t: 'del', text: l.slice(1) });
      idx.push(j);
      j += 1;
    } else if (l[0] === '+') {
      ops.push({ t: 'add', text: l.slice(1) });
      idx.push(j);
      j += 1;
    } else if (l[0] === '\\') {
      bsAt.push(j);
      j += 1;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (ops.length > 0 && ops[ops.length - 1]!.t === 'ctx' && ops[ops.length - 1]!.text === '') {
    ops.pop();
    j = idx.pop()!;
  }
  // Whether a `\` line follows the hunk's last context or `+` line.
  let bsAfterLast = false;
  let lastCtxAdd = -1;
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k]!.t === 'ctx' || ops[k]!.t === 'add') lastCtxAdd = k;
  }
  if (lastCtxAdd >= 0) bsAfterLast = bsAt.includes(idx[lastCtxAdd]! + 1);
  return { ops, bsAfterLast, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let seenSection = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec = parseSection(lines, i, m[1]!, m[2]!);
      edits.push(makeUnifiedEdit(sec, strict));
      i = sec.next;
      seenSection = true;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = parseSection(lines, i, null, null);
      edits.push(makeUnifiedEdit(sec, strict));
      i = sec.next;
      seenSection = true;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (!seenSection) throw new Exit2('error: parse 1');
  return edits;
}

function parseSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null): Section & { next: number } {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isNew = false;
  let isDel = false;
  let hasDashPair = false;
  let i = start;
  if (lines[i]!.startsWith('diff --git ')) i += 1;
  // The header: up to the first hunk.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (hasDashPair) break;
        const o = headerPath(l);
        const n = headerPath(lines[i + 1]!);
        oldPath = o === '' ? null : o;
        newPath = n === '' ? null : n;
        hasDashPair = true;
        i += 2;
      } else {
        throw new Exit2(`error: parse ${i + 2}`);
      }
    } else if (l.startsWith('rename from ')) {
      if (!hasDashPair && oldPath === null) oldPath = l.slice('rename from '.length).trim();
      i += 1;
    } else if (l.startsWith('rename to ')) {
      if (!hasDashPair && newPath === null) newPath = l.slice('rename to '.length).trim();
      i += 1;
    } else if (l.startsWith('new file mode')) {
      isNew = true;
      i += 1;
    } else if (l.startsWith('deleted file mode')) {
      isDel = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (oldPath === null) oldPath = gitOld;
  if (newPath === null) newPath = gitNew;
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      hunks.push({ a: Number(m[1]), ops: body.ops, bsAfterLast: body.bsAfterLast });
      i = body.next;
    } else if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      break;
    } else {
      i += 1;
    }
  }
  return { oldPath, newPath, isNew, isDel, hunks, next: i };
}

/** Apply a section's hunks, in order, to the file's lines. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = fileParts(text);
  const lines = parts.lines;
  let d = 0;
  for (const hunk of hunks) {
    const o = opOld(hunk.ops);
    const n = opNew(hunk.ops);
    if (o.length > 0) {
      const found = findFirstTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const rep = buildReplacement(hunk.ops, lines, pos, found.tier);
      if (pos + o.length === lines.length) parts.final = !hunk.bsAfterLast;
      lines.splice(pos, o.length, ...rep);
      d += n.length - o.length;
    } else {
      const at = Math.min(hunk.a + d, lines.length);
      if (at === lines.length) parts.final = !hunk.bsAfterLast;
      lines.splice(at, 0, ...n);
      d += n.length;
    }
  }
  return joinParts(parts);
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = oldP === null || sec.isNew;
  const isDelete = !isCreate && (newP === null || sec.isDel);
  return (tree) => {
    if (isCreate) {
      const p = newP ?? oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.t === 'add') plus.push(op.text);
      let final = true;
      for (let h = sec.hunks.length - 1; h >= 0; h -= 1) {
        if (sec.hunks[h]!.ops.some((o) => o.t === 'add')) {
          final = !sec.hunks[h]!.bsAfterLast;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP ?? '';
    const n = newP ?? '';
    if (o !== n) {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const out = applyHunks(before, sec.hunks, strict, o);
      tree.now.set(n, out);
      tree.now.set(o, null);
      tree.moves.push({ old: o, next: n });
      return;
    }
    if (!safe(o)) throw new Fail('unsafe', o);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    tree.now.set(o, applyHunks(before, sec.hunks, strict, o));
  };
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => makeSREdit(b, strict));
}

function makeSREdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = fileParts(before);
    const found = findFirstTier(parts.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const p = leadingWS(b.oldLines[0]!);
    const f = leadingWS(parts.lines[pos]!);
    const rep = b.newLines.map((l) => (found.tier === 2 ? reindentLine(l, p, f) : l));
    parts.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinParts(parts));
  };
}

/** One V4A section (SPEC.md section 8). */
type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

interface V4AChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) {
      const kind = l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : 'update';
      const marker = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
      const path = l.slice(marker.length).trim();
      const bodyStart = i + 1;
      let j = bodyStart;
      while (j < last) {
        const m = lines[j]!;
        if (m.startsWith('*** Add File:') || m.startsWith('*** Delete File:') || m.startsWith('*** Update File:')) break;
        j += 1;
      }
      // Blank lines at the end of a section are not part of it.
      let bodyEnd = j;
      while (bodyEnd > bodyStart && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
      const body = lines.slice(bodyStart, bodyEnd);
      edits.push(makeV4AEdit(parseV4ASection(kind, path, body, i + 1), strict));
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4ASection(kind: 'add' | 'delete' | 'update', path: string, body: string[], lineNo: number): V4ASection {
  if (kind === 'add') {
    const out: string[] = [];
    for (let k = 0; k < body.length; k += 1) {
      const l = body[k]!;
      if (l === '') out.push('');
      else if (l[0] === '+') out.push(l.slice(1));
      else throw new Exit2(`error: parse ${lineNo + 1 + k}`);
    }
    return { kind: 'add', path, lines: out };
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new Exit2(`error: parse ${lineNo + 1}`);
    return { kind: 'delete', path };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to:')) {
    moveTo = body[0]!.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (let k = idx; k < body.length; k += 1) {
    const l = body[k]!;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
    } else if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo + 1 + k}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) cur = { anchor: null, ops: [], eof: false };
      if (l === '') cur.ops.push({ t: 'ctx', text: '' });
      else if (l[0] === ' ') cur.ops.push({ t: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.ops.push({ t: 'del', text: l.slice(1) });
      else cur.ops.push({ t: 'add', text: l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${lineNo + 1 + k}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return { kind: 'update', path, moveTo, chunks };
}

function makeV4AEdit(sec: V4ASection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = fileParts(before);
    const lines = parts.lines;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundAt: number | null = null;
        for (const tier of tiersToTry(strict)) {
          for (let q = cursor; q < lines.length; q += 1) {
            if (normLine(lines[q]!, tier) === normLine(chunk.anchor, tier)) {
              foundAt = q;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const o = opOld(chunk.ops);
      const n = opNew(chunk.ops);
      if (o.length > 0) {
        if (chunk.eof) {
          // An end-of-file chunk takes only an occurrence that ends at the
          // file's last line: the one starting at lines.length - o.length.
          const endPos = lines.length - o.length;
          if (endPos < cursor) throw new Fail('no-match', sec.path);
          let tierFound: number | null = null;
          for (const tier of tiersToTry(strict)) {
            let ok = true;
            for (let j = 0; j < o.length; j += 1) {
              if (normLine(lines[endPos + j]!, tier) !== normLine(o[j]!, tier)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              tierFound = tier;
              break;
            }
          }
          if (tierFound === null) throw new Fail('no-match', sec.path);
          const rep = buildReplacement(chunk.ops, lines, endPos, tierFound);
          lines.splice(endPos, o.length, ...rep);
          cursor = endPos + rep.length;
        } else {
          const found = findFirstTierFrom(lines, o, cursor, strict);
          if (found === null) throw new Fail('no-match', sec.path);
          const pos = found.pos[0]!;
          const rep = buildReplacement(chunk.ops, lines, pos, found.tier);
          lines.splice(pos, o.length, ...rep);
          cursor = pos + rep.length;
        }
      } else {
        const at = chunk.eof ? lines.length : cursor;
        lines.splice(at, 0, ...n);
        cursor = at + n.length;
      }
    }
    const out = joinParts(parts);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push({ old: sec.path, next: sec.moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.next) === null && tree.get(m.next) !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      moved.add(m.old);
      moved.add(m.next);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const m of tree.moves) {
      if (!moved.has(m.old) || !moved.has(m.next)) continue;
      const content = tree.get(m.next);
      if (content === null) continue;
      mkdirSync(dirname(m.next), { recursive: true });
      writeFileSync(m.next, content);
      rmSync(m.old, { force: true });
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
