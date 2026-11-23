// The standalone browser factory cannot import JSON. Its only embedded version is generated from the manifest.
import { readFile, writeFile } from 'node:fs/promises';
const manifest = new URL('../package.json', import.meta.url);
const bundle = new URL('../client.js', import.meta.url);
const { version } = JSON.parse(await readFile(manifest, 'utf8'));
const source = await readFile(bundle, 'utf8');
const declaration = /^(\s*const PLUGIN_VERSION = )"[^"\r\n]+";/gm;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version) || [...source.matchAll(declaration)].length !== 1) throw Error('Invalid package version or missing client version declaration');
const next = source.replace(declaration, (_, prefix) => `${prefix}${JSON.stringify(version)};`);
if (next !== source) {
  if (!process.argv.includes('--write')) throw Error('Client version differs from package.json. Run npm run version:sync before publishing.');
  await writeFile(bundle, next);
}
console.log(`Package and client version: ${version}`);
