// Fold sibling members whose names start with the same characters into one
// group row (e.g. 12 × "Bearing bar 30x3", or "Frame angle … long/short").

const trimTail = (s) => s.replace(/[\s\-_.,:;/\\(\[#]+$/, '');

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return a.slice(0, i);
}

/**
 * names: sibling names in tree order. Returns [{ label, key, members: [indices] }]
 * for every set of 2+ names sharing their first `minLen` characters (case and
 * leading/trailing spaces ignored). A set that would hold every sibling is not
 * returned, because it would only add a level. The label is the members'
 * longest common prefix, with trailing separators trimmed.
 */
export function prefixGroups(names, minLen = 3) {
  const buckets = new Map();
  names.forEach((raw, i) => {
    const name = String(raw || '').trim();
    if (name.length < minLen) return;
    const key = name.slice(0, minLen).toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  const out = [];
  for (const [key, members] of buckets) {
    if (members.length < 2 || members.length === names.length) continue;
    let label = String(names[members[0]]).trim();
    for (const i of members.slice(1)) label = commonPrefix(label, String(names[i]).trim());
    const trimmed = trimTail(label);
    out.push({ key, label: trimmed.length >= minLen ? trimmed : label, members });
  }
  return out.sort((a, b) => a.members[0] - b.members[0]);
}
