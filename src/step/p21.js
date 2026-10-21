// Minimal ISO 10303-21 (STEP physical file) reader / writer for editing.
// Entities are parsed into typed parameter trees; untouched entities are
// written back byte-for-byte from the original text.
//
// Value forms:  { r: 12 } reference · { s: "'text'" } string (raw, quoted)
//               { e: '.T.' } enumeration · { n: '1.5E-3' } number (raw text)
//               '$' unset · '*' derived · [ ... ] aggregate
//               { t: 'LENGTH_MEASURE', v: [ ... ] } typed parameter

export function parseP21(text) {
  const dataStart = findKeyword(text, 'DATA;', 0);
  if (dataStart < 0) throw new Error('not a STEP file (no DATA section)');
  const dataBody = dataStart + 5;
  const entities = new Map();
  const order = [];
  let i = dataBody;
  const n = text.length;
  let endsec = -1;
  while (i < n) {
    i = skipWs(text, i);
    if (i >= n) break;
    if (text.startsWith('ENDSEC', i)) { endsec = i; break; }
    if (text[i] !== '#') throw new Error(`STEP parse error near character ${i}`);
    const start = i;
    const end = findEntityEnd(text, i); // index of the closing ';'
    const raw = text.slice(start, end + 1);
    const eq = raw.indexOf('=');
    const id = parseInt(raw.slice(1, eq), 10);
    const body = raw.slice(eq + 1, raw.length - 1);
    entities.set(id, { id, start, end: end + 1, raw, body, parts: null });
    order.push(id);
    i = end + 1;
  }
  if (endsec < 0) throw new Error('STEP parse error: DATA section not closed');
  return { text, head: text.slice(0, dataBody), tail: text.slice(endsec), entities, order };
}

function findKeyword(text, kw, from) {
  // the keyword outside comments / strings: HEADER is short, a plain search is enough
  return text.indexOf(kw, from);
}

function skipWs(t, i) {
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
    return i;
  }
}

function findEntityEnd(t, i) {
  let depth = 0;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === "'") { i++; while (i < t.length) { if (t[i] === "'") { if (t[i + 1] === "'") { i += 2; continue; } break; } i++; } continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) return i;
  }
  throw new Error('STEP parse error: entity not terminated');
}

/** Parse an entity body into [{ name, args }] (one item, or several for a complex entity). */
export function entityParts(ent) {
  if (ent.parts) return ent.parts;
  const p = new ArgParser(ent.body);
  p.ws();
  const parts = [];
  if (p.peek() === '(') {
    // complex entity: ( NAME(args) NAME(args) ... )
    p.i++;
    for (;;) {
      p.ws();
      if (p.peek() === ')') { p.i++; break; }
      const name = p.keyword();
      parts.push({ name, args: p.list() });
    }
  } else {
    const name = p.keyword();
    parts.push({ name, args: p.list() });
  }
  ent.parts = parts;
  return parts;
}

export const typeOf = (ent) => entityParts(ent).map(p => p.name).join('+');
export const hasType = (ent, name) => entityParts(ent).some(p => p.name === name);
export const argsOf = (ent, name) => { const p = entityParts(ent).find(x => x.name === name); return p ? p.args : null; };

class ArgParser {
  constructor(s) { this.s = s; this.i = 0; }
  peek() { return this.s[this.i]; }
  ws() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s[this.i] === '/' && s[this.i + 1] === '*') { const e = s.indexOf('*/', this.i + 2); this.i = e < 0 ? s.length : e + 2; continue; }
      return;
    }
  }
  keyword() {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) throw new Error('STEP parse error: keyword expected in ' + this.s.slice(0, 80));
    this.i += m[0].length;
    return m[0].toUpperCase();
  }
  list() {
    this.ws();
    if (this.s[this.i] !== '(') throw new Error('STEP parse error: ( expected');
    this.i++;
    const out = [];
    this.ws();
    if (this.s[this.i] === ')') { this.i++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === ',') continue;
      if (c === ')') return out;
      throw new Error('STEP parse error: , or ) expected');
    }
  }
  value() {
    this.ws();
    const s = this.s, c = s[this.i];
    if (c === '(') return this.list();
    if (c === '#') { const m = /^#(\d+)/.exec(s.slice(this.i, this.i + 20)); this.i += m[0].length; return { r: parseInt(m[1], 10) }; }
    if (c === "'") {
      const st = this.i; this.i++;
      while (this.i < s.length) { if (s[this.i] === "'") { if (s[this.i + 1] === "'") { this.i += 2; continue; } break; } this.i++; }
      this.i++;
      return { s: s.slice(st, this.i) };
    }
    if (c === '"') { const e = s.indexOf('"', this.i + 1); const v = s.slice(this.i, e + 1); this.i = e + 1; return { s: v }; }
    if (c === '.') { const e = s.indexOf('.', this.i + 1); const v = s.slice(this.i, e + 1); this.i = e + 1; return { e: v }; }
    if (c === '$' || c === '*') { this.i++; return c; }
    if (/[A-Za-z_]/.test(c)) { const t = this.keyword(); return { t, v: this.list() }; }
    const m = /^[+-]?[0-9.]+(?:[Ee][+-]?[0-9]+)?/.exec(s.slice(this.i, this.i + 60));
    if (!m) throw new Error('STEP parse error: value expected near ' + s.slice(this.i, this.i + 30));
    this.i += m[0].length;
    return { n: m[0] };
  }
}

/** All references in a value tree, with whether each sits inside an aggregate. */
export function refsOf(ent) {
  if (ent.refs) return ent.refs;
  const out = [];
  const walk = (v, inList) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, true); return; }
    if (v && typeof v === 'object') {
      if ('r' in v) out.push({ id: v.r, inList });
      else if ('t' in v) for (const x of v.v) walk(x, inList);
    }
  };
  for (const p of entityParts(ent)) for (const a of p.args) walk(a, false);
  ent.refs = out;
  return out;
}

export function serializeValue(v) {
  if (Array.isArray(v)) return '(' + v.map(serializeValue).join(',') + ')';
  if (v === '$' || v === '*') return v;
  if ('r' in v) return '#' + v.r;
  if ('s' in v) return v.s;
  if ('e' in v) return v.e;
  if ('n' in v) return v.n;
  if ('t' in v) return v.t + '(' + v.v.map(serializeValue).join(',') + ')';
  throw new Error('cannot serialize value');
}

export function serializeEntity(ent) {
  const parts = entityParts(ent);
  const body = parts.length > 1 || ent.body.trim().startsWith('(')
    ? '(' + parts.map(p => p.name + '(' + p.args.map(serializeValue).join(',') + ')').join('') + ')'
    : parts[0].name + '(' + parts[0].args.map(serializeValue).join(',') + ')';
  return `#${ent.id}=${body};`;
}

/** Write a file keeping untouched entities verbatim. `changed` holds re-serialised entities; `drop` ids are omitted. */
export function writeP21(file, drop, changed) {
  const out = [file.head, '\n'];
  for (const id of file.order) {
    if (drop.has(id)) continue;
    out.push(changed.has(id) ? serializeEntity(changed.get(id)) : file.entities.get(id).raw, '\n');
  }
  out.push(file.tail);
  return out.join('');
}
