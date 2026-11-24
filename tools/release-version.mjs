// Public releases use A.B.C.D; npm accepts A.B.C-rev.D. Historical A.B.C stays unchanged.
// A stable legacy A.B.C outranks every prerelease on that same core under npm SemVer.
const component = '(0|[1-9][0-9]*)';
const core = [component, component, component].join('\\.');
const displayPattern = new RegExp(`^${core}(?:\\.${component})?$`);
const packagePattern = new RegExp(`^${core}(?:-rev\\.${component})?$`);
const max = BigInt(Number.MAX_SAFE_INTEGER);

function parts(value, pattern) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = pattern.exec(value);
  if (!match || match[0] !== value) return null;
  const fields = match.slice(1).filter(v => v !== undefined);
  return fields.every(v => BigInt(v) <= max) ? fields : null;
}

/** Convert a supported, canonical npm package version to its public display/tag/notes spelling. */
export function displayVersion(raw) {
  return parts(raw, packagePattern)?.join('.') ?? null;
}

/** Encode a public release number for package.json and the browser's embedded manifest version. */
export function packageVersion(display) {
  const fields = parts(display, displayPattern);
  if (!fields) return null;
  return fields.length === 3 ? display : `${fields.slice(0, 3).join('.')}-rev.${fields[3]}`;
}

/** Compare a proposed display number with the repository's raw package version. */
export function higherVersion(proposed, raw) {
  const a = parts(proposed, displayPattern), b = parts(raw, packagePattern);
  if (!a || !b || a.length < b.length) return false; // never return to three parts after migration
  for (let i = 0; i < 3; i++) {
    const left = BigInt(a[i]), right = BigInt(b[i]);
    if (left !== right) return left > right;
  }
  return b.length === 4 && BigInt(a[3]) > BigInt(b[3]);
}

/** Increment the fourth component; carry if needed rather than producing an invalid npm version. */
export function nextVersion(raw) {
  const fields = parts(raw, packagePattern);
  if (!fields) return null;
  const legacy = fields.length === 3;
  const values = fields.map(BigInt);
  if (legacy) values.push(1n);
  for (let i = legacy ? 2 : 3; i >= 0; i--) {
    if (values[i] < max) { values[i]++; return values.join('.'); }
    values[i] = 0n;
  }
  return null;
}
