// Read the length unit declared in a STEP or IGES file. occt-import-js converts
// the geometry to mm for us; this is only to show the user what the file said.

const SI_PREFIX = { MILLI: 'mm', CENTI: 'cm', DECI: 'dm', MICRO: 'µm', KILO: 'km', NANO: 'nm' };

function unitOfEntity(ent) {
  const conv = ent.match(/CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/);
  if (conv) return conv[1].toLowerCase();
  const si = ent.match(/SI_UNIT\s*\(\s*(\.([A-Z]+)\.|\$|\*)\s*,\s*\.METRE\./);
  if (si) return si[2] ? (SI_PREFIX[si[2]] || si[2].toLowerCase() + 'metre') : 'm';
  return null;
}

/**
 * The length unit the geometry is measured in: the LENGTH_UNIT listed by the
 * GLOBAL_UNIT_ASSIGNED_CONTEXTs (most common one if they differ). A file can
 * also define other length units, e.g. mm as the base of an INCH conversion,
 * so the first LENGTH_UNIT in the file is not necessarily the one in use.
 */
export function detectStepUnit(text) {
  const upper = text.toUpperCase();
  const entityText = (id) => {
    const m = new RegExp('#' + id + '\\s*=([^;]*);').exec(upper);
    return m ? m[1] : '';
  };
  const counts = new Map();
  const re = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(upper)) !== null) {
    for (const r of m[1].match(/#\d+/g) || []) {
      const ent = entityText(r.slice(1));
      if (!/LENGTH_UNIT/.test(ent)) continue;
      const u = unitOfEntity(ent);
      if (u) counts.set(u, (counts.get(u) || 0) + 1);
    }
  }
  if (counts.size) return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  // fallback: the first length unit in the file
  const re2 = /[^;]*LENGTH_UNIT[^;]*;/g;
  while ((m = re2.exec(upper)) !== null) { const u = unitOfEntity(m[0]); if (u) return u; }
  return 'unknown';
}

const IGES_UNITS = { 1: 'inch', 2: 'mm', 3: 'see unit name', 4: 'foot', 5: 'mile', 6: 'm', 7: 'km', 8: 'mil', 9: 'µm', 10: 'cm', 11: 'microinch' };

/** Parse the IGES global section (parameter 14 = unit flag, 15 = unit name). */
export function detectIgesUnit(text) {
  const lines = text.split(/\r?\n/);
  let g = '';
  for (const l of lines) if (l.length >= 73 && l[72] === 'G') g += l.slice(0, 72);
  if (!g) return 'unknown';
  let pd = ',', rd = ';';
  // the first two parameters may redefine the delimiters as 1Hx
  let pos = 0;
  const readDelim = () => {
    if (g.startsWith('1H', pos)) { const c = g[pos + 2]; pos += 3; return c; }
    return null;
  };
  const d1 = readDelim();
  if (d1) pd = d1;
  if (g[pos] === pd) pos++;
  const d2 = readDelim();
  if (d2) rd = d2;
  if (g[pos] === pd) pos++;
  const params = [pd, rd];
  while (pos < g.length && params.length < 16) {
    const h = g.slice(pos).match(/^\s*(\d+)H/);
    let val;
    if (h) {
      const n = parseInt(h[1], 10);
      const start = pos + h[0].length;
      val = g.substr(start, n);
      pos = start + n;
    } else {
      let end = pos;
      while (end < g.length && g[end] !== pd && g[end] !== rd) end++;
      val = g.slice(pos, end).trim();
      pos = end;
    }
    params.push(val);
    if (g[pos] === rd) break;
    pos++;
  }
  const flag = parseInt(params[13], 10);
  if (flag === 3 && params[14]) return params[14];
  return IGES_UNITS[flag] || 'unknown';
}

export function detectUnit(bytes, format) {
  const text = new TextDecoder('latin1').decode(bytes);
  return format === 'iges' ? detectIgesUnit(text) : detectStepUnit(text);
}
