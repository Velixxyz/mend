// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFile(model: FileModel): string {
  if (model.lines.length === 0) return '';
  return model.lines.join(model.br) + (model.final ? model.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Positions where O occurs in the file's lines at one tier (overlaps allowed). */
function occurrencesAt(file: string[], old: string[], tier: number): number[] {
  const key = (s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));
  const o = old.map(key);
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (key(file[i + j]!) !== o[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or null (section 5). */
function findTier(file: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(file, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** The lines N writes for an occurrence of O at `at`, at the tier found. */
function buildReplacement(file: string[], at: number, old: string[], nlines: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 ? leadWs(file[at] ?? '') : '';
  const p = tier === 2 && old.length > 0 ? leadWs(old[0]!) : '';
  for (const nl of nlines) {
    if (nl.ctx) { out.push(file[at + nl.oIndex]!); continue; }
    if (tier === 2 && !/^[ \t]*$/.test(nl.text) && nl.text.startsWith(p)) {
      out.push(f + nl.text.slice(p.length));
      continue;
    }
    out.push(nl.text);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** Moves a successful edit recorded, for the `R` output line (section 2). */
const moves: [string, string][] = [];

interface HunkBody {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  slash: boolean;
}

interface Hunk {
  a: number;
  body: HunkBody[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One hunk at lines[at]; returns it and the index after its body. */
function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[at]!);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const body: HunkBody[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.slash = true;
      j += 1;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      body.push({ kind: l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l === '' ? '' : l.slice(1), slash: false });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { hunk: { a: Number(m[1]), body }, next: j };
}

/** Apply a section's hunks in order to a file model (section 6). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NewLine[] = [];
    let lastSlash = false;
    let haveCtxPlus = false;
    for (const e of h.body) {
      if (e.kind === 'ctx') {
        const oi = o.length;
        o.push(e.text);
        n.push({ text: e.text, ctx: true, oIndex: oi });
        haveCtxPlus = true;
        lastSlash = e.slash;
      } else if (e.kind === 'old') {
        o.push(e.text);
      } else {
        n.push({ text: e.text, ctx: false, oIndex: -1 });
        haveCtxPlus = true;
        lastSlash = e.slash;
      }
    }
    if (o.length > 0) {
      const found = findTier(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const atEnd = best + o.length === model.lines.length;
      const rep = buildReplacement(model.lines, best, o, n, found.tier);
      model.lines.splice(best, o.length, ...rep);
      if (atEnd) model.final = haveCtxPlus ? !lastSlash : true;
    } else {
      const ins = Math.max(0, Math.min(h.a + d, model.lines.length));
      const atEnd = ins === model.lines.length;
      model.lines.splice(ins, 0, ...n.map((x) => x.text));
      if (atEnd) model.final = haveCtxPlus ? !lastSlash : true;
    }
    d += n.length - o.length;
  }
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  header: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed. */
function diffPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let i = 0;
  const fresh = (gitOld: string | null, gitNew: string | null): USection => {
    const s: USection = { gitOld, gitNew, pairOld: null, pairNew: null, renOld: null, renNew: null, create: false, del: false, header: true, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = fresh(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = fresh(null, null);
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (sec.header) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.pairOld = stripAB(diffPath(line));
        sec.pairNew = stripAB(diffPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) { sec.renOld = line.slice('rename from '.length).trim(); i += 1; continue; }
      if (line.startsWith('rename to ')) { sec.renNew = line.slice('rename to '.length).trim(); i += 1; continue; }
      if (line.startsWith('new file mode')) { sec.create = true; i += 1; continue; }
      if (line.startsWith('deleted file mode')) { sec.del = true; i += 1; continue; }
      if (line.startsWith('@@')) {
        const r = parseHunk(lines, i);
        sec.hunks.push(r.hunk);
        sec.header = false;
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = fresh(null, null);
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const rawOld = sec.pairOld ?? sec.renOld ?? sec.gitOld;
  const rawNew = sec.pairNew ?? sec.renNew ?? sec.gitNew;
  const oldPath = rawOld === '/dev/null' ? null : rawOld;
  const newPath = rawNew === '/dev/null' ? null : rawNew;
  const isCreate = sec.create || rawOld === '/dev/null';
  const isDelete = sec.del || rawNew === '/dev/null';
  if (isCreate) {
    return (tree) => {
      if (newPath === null) throw new Fail('unsafe', '');
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastSlash = false;
      let havePlus = false;
      for (const h of sec.hunks) {
        for (const e of h.body) {
          if (e.kind === 'new') { plus.push(e.text); havePlus = true; lastSlash = e.slash; }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (havePlus && lastSlash ? '' : '\n'));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (oldPath === null) throw new Fail('missing', '');
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const model = parseFile(before);
      applyHunks(model, sec.hunks, strict, oldPath);
      tree.now.set(newPath, writeFile(model));
      tree.now.set(oldPath, null);
      moves.push([oldPath, newPath]);
    };
  }
  return (tree) => {
    const p = oldPath ?? newPath;
    if (p === null) throw new Fail('missing', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, p);
    tree.now.set(p, writeFile(model));
  };
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const n = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const rep = buildReplacement(model.lines, at, oldLines, n, found.tier);
    model.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, writeFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { end = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** First line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(file: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = (s: string): string => (t === 0 ? s : t === 1 ? trimEndWs(s) : trimWs(s));
    const want = key(anchor);
    for (let i = from; i < file.length; i += 1) {
      if (key(file[i]!) === want) return i;
    }
  }
  return null;
}

/** First tier with an occurrence at or after `from` (end-of-file chunks: ending at the last line). */
function findTierFrom(file: string[], old: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(file, old, t).filter((p) => p >= from && (!eof || p + old.length === file.length));
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkBody[];
}

function v4aSectionEdit(kind: 'add' | 'delete' | 'update', path: string, secLines: string[], secAbsStart: number, headerLineNo: number, strict: boolean): Edit {
  if (kind === 'add') {
    const flines: string[] = [];
    for (let k = 0; k < secLines.length; k += 1) {
      const l = secLines[k]!;
      if (l === '') flines.push('');
      else if (l.startsWith('+')) flines.push(l.slice(1));
      else throw new Exit2(`error: parse ${secAbsStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (secLines.length > 0) throw new Exit2(`error: parse ${secAbsStart + 1}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let k = 0;
  if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; k < secLines.length; k += 1) {
    const l = secLines[k]!;
    const lineNo = secAbsStart + k + 1;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
      chunks.push(cur);
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ kind: l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l === '' ? '' : l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(model.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const e of ch.body) {
        if (e.kind === 'ctx') {
          const oi = o.length;
          o.push(e.text);
          n.push({ text: e.text, ctx: true, oIndex: oi });
        } else if (e.kind === 'old') {
          o.push(e.text);
        } else {
          n.push({ text: e.text, ctx: false, oIndex: -1 });
        }
      }
      if (o.length > 0) {
        const found = findTierFrom(model.lines, o, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.pos[0]!;
        const rep = buildReplacement(model.lines, at, o, n, found.tier);
        model.lines.splice(at, o.length, ...rep);
        cursor = at + rep.length;
      } else {
        const ins = ch.eof ? model.lines.length : cursor;
        model.lines.splice(ins, 0, ...n.map((x) => x.text));
        cursor = ins + n.length;
      }
    }
    const text = writeFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) { kind = 'add'; path = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; path = line.slice('*** Delete File: '.length).trim(); }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; path = line.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const headerLineNo = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j += 1;
    }
    const secLines = lines.slice(start, j);
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
    edits.push(v4aSectionEdit(kind, path, secLines, start, headerLineNo, strict));
    i = j;
  }
  return edits;
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  moves.length = 0;
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mv = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = mv;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
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
