export const SVG_MIME = 'image/svg+xml';
export const GIF_MIME = 'image/gif';
export const MAX_RESULT_BYTES = 24 * 1024 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const xmlName = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
const startTag = new RegExp(`<(${xmlName})`, 'y');
const endTag = new RegExp(`</(${xmlName})[ \\t\\r\\n]*>`, 'y');
const attribute = new RegExp(`[ \\t\\r\\n]+(${xmlName})[ \\t\\r\\n]*=[ \\t\\r\\n]*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
const tagEnd = /[ \t\r\n]*(\/?)>/y;
const decoder = new TextDecoder('utf-8', {fatal: true});
const xmlDeclaration = /^<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/;

function hasInvalidXmlReference(text) {
  return /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text);
}

function svgDimensions(attributes) {
  const width = svgLength(attributes.get('width'));
  const height = svgLength(attributes.get('height'));
  const viewBox = attributes.get('viewBox')?.trim().split(/[ ,\t\r\n]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return {width: width || viewBox[2], height: height || viewBox[3]};
  }
  return {width, height};
}

function svgLength(value) {
  const match = /^(\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:px)?$/i.exec(value?.trim() || '');
  const length = Number(match?.[1]);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

/** Recognize a standalone SVG document without expanding entities or executing markup. */
export function svgResultInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RESULT_BYTES || !bytes.length) return null;
  // Most result bytes are raster images. Check the first nonblank byte before decoding.
  let begin = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  while ([9, 10, 13, 32].includes(bytes[begin])) begin++;
  if (bytes[begin] !== 0x3c) return null;
  let xml;
  try { xml = decoder.decode(bytes); } catch { return null; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(xml)) return null;

  const declaration = xmlDeclaration.exec(xml)?.[0] || '';
  let index = declaration.length;
  let dimensions = null;
  const opened = [];
  const at = (pattern) => { pattern.lastIndex = index; return pattern.exec(xml); };
  while (index < xml.length) {
    const next = xml.indexOf('<', index);
    const text = xml.slice(index, next < 0 ? xml.length : next);
    if (!opened.length && !/^[ \t\r\n]*$/.test(text)) return null;
    if (opened.length && (hasInvalidXmlReference(text) || text.includes(']]>'))) return null;
    if (next < 0) break;
    index = next;
    if (xml.startsWith('<!--', index) || (opened.length && xml.startsWith('<![CDATA[', index))) {
      const comment = xml.startsWith('<!--', index);
      const end = xml.indexOf(comment ? '-->' : ']]>', index + (comment ? 4 : 9));
      if (end < 0 || (comment && xml.slice(index + 4, end).includes('--'))) return null;
      index = end + 3;
      continue;
    }
    const close = at(endTag);
    if (close) {
      if (opened.pop() !== close[1]) return null;
      index = endTag.lastIndex;
      continue;
    }
    const open = at(startTag);
    if (!open || (dimensions && !opened.length)) return null;
    index = startTag.lastIndex;
    const attributes = new Map();
    let field;
    while ((field = at(attribute))) {
      const value = field[2] ?? field[3];
      if (attributes.has(field[1]) || hasInvalidXmlReference(value)) return null;
      attributes.set(field[1], value);
      index = attribute.lastIndex;
    }
    const end = at(tagEnd);
    if (!end) return null;
    index = tagEnd.lastIndex;
    if (!dimensions) {
      const [prefix, local] = open[1].split(':');
      if ((local || prefix) !== 'svg' || attributes.get(local ? `xmlns:${prefix}` : 'xmlns') !== SVG_NS) return null;
      dimensions = svgDimensions(attributes);
    }
    if (!end[1]) opened.push(open[1]);
  }
  return dimensions && !opened.length ? {mime: SVG_MIME, format: 'svg', ...dimensions} : null;
}

export function gifResultInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_RESULT_BYTES) return null;
  const signature = bytes.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  return width && height ? {mime: GIF_MIME, format: 'gif', width, height} : null;
}

const resultDataHeader = /^data:(image\/(?:svg\+xml|gif))(?:;charset=utf-8)?(;base64)?,/i;
export const isResultDataUrl = value => typeof value === 'string' && resultDataHeader.test(value.trimStart());

/** Recognize a document, a data URL or Base64 while retaining the upstream bytes. */
export function decodeImageResult(value, expectedMime) {
  if (typeof value !== 'string' || value.length > MAX_RESULT_BYTES * 4 + 128) return null;
  const probe = value.trimStart();
  const header = resultDataHeader.exec(probe);
  const declaredMime = header?.[1].toLowerCase();
  let buffer;
  if (probe.startsWith('<')) {
    buffer = Buffer.from(value, 'utf8');
  } else if (header && !header[2]) {
    if (declaredMime !== SVG_MIME) return null;
    try { buffer = Buffer.from(decodeURIComponent(probe.slice(header[0].length)), 'utf8'); }
    catch { return null; }
  } else {
    const data = (header ? probe.slice(header[0].length) : probe).replace(/[ \t\r\n]/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 || data.length > Math.ceil(MAX_RESULT_BYTES / 3) * 4) return null;
    buffer = Buffer.from(data, 'base64');
  }
  const info = gifResultInfo(buffer) || svgResultInfo(buffer);
  if (!info || (declaredMime && info.mime !== declaredMime) || (expectedMime && info.mime !== expectedMime)) return null;
  return {kind: 'b64', buffer, mime: info.mime};
}
