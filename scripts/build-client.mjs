#!/usr/bin/env node
/**
 * Build the browser half of @yukari316/dsh-toolcall-compat into the exact
 * bundle format DSH's client module system requires.
 *
 * DSH serves /plugins/<id>/client.js raw and loads it as a classic script;
 * the script MUST synchronously call
 *   window.__ModuleLoader__.load({ id, factory })
 * or the module system throws "loaded without registering" and the whole
 * plugin entry fails (which aborts DSH startup). A plain tsc ESM output
 * cannot do that, so we bundle src/client.ts with esbuild and wrap it.
 *
 * The factory is lazy-CJS: it receives DSH's own `require`, which resolves
 * seed words (react, @deepseek-ai/cordis, ...) and registered graph rows.
 * Our client half needs only `react` at runtime (locales/format are bundled
 * inline; all @deepseek-ai imports in src/client.ts are type-only), so the
 * externals list below is deliberately small.
 *
 * The esbuild CLI is driven directly (spawnSync, stdio inherit, outfile) so
 * the script also runs where the JS API's in-process binary spawn is
 * restricted.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const PACKAGE_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).name

const entry = fileURLToPath(new URL('../src/client.ts', import.meta.url))
const outfile = fileURLToPath(new URL('../lib/client.esbuild.js', import.meta.url))
const esbuildCli = require.resolve('esbuild/bin/esbuild')

const args = [
  esbuildCli,
  entry,
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--external:react',
  '--external:react/jsx-runtime',
  '--external:@deepseek-ai/*',
  `--outfile=${outfile}`,
  '--log-level=warning',
]

const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error !== undefined) {
  console.error(`failed to run esbuild: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

const code = readFileSync(outfile, 'utf8')
unlinkSync(outfile)

// Verify the bundle only requires seed words / graph rows the module table
// can answer. Anything else would throw at materialization time.
const requires = [...code.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((m) => m[1])
const unexpected = requires.filter(
  (spec) => !spec.startsWith('react') && !spec.startsWith('@deepseek-ai/'),
)
if (unexpected.length > 0) {
  throw new Error(`client bundle requires unresolvable modules: ${unexpected.join(', ')}`)
}

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code}
\t\tObject.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
\t\treturn module.exports;
\t}
});
`

writeFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), wrapped)
console.log(`client bundle written to lib/client.js (${wrapped.length} bytes, id ${PACKAGE_NAME})`)
