#!/usr/bin/env node
/**
 * One-command installer for @yukari316/dsh-toolcall-compat.
 *
 * Usage:
 *   npx -y @yukari316/dsh-toolcall-compat            # install into the web profile
 *   npx -y @yukari316/dsh-toolcall-compat --profile headless
 *   node scripts/install.mjs --home C:\path\to\.dsh  # custom DSH home
 *
 * What it does:
 *   1. Locates the profile directory (default: <DSH_HOME>/profiles/web).
 *   2. Runs `npm install --omit=peer <package>` inside it, so the DSH loader
 *      can resolve the plugin from the profile directory.
 *   3. Appends this package to `dsh.profile.bundles` in the profile manifest
 *      (idempotent), so DSH applies the package's cordis.patch.yml at boot.
 *
 * After it finishes, restart DSH (`dsh web`). No manual file editing needed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).name

const WEB_TEMPLATE = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}

function parseArgs(argv) {
  const options = { profile: 'web', home: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') options.profile = argv[++i]
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--home') options.home = argv[++i]
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: dsh-toolcall-compat [--profile <name>] [--home <DSH_HOME>]\n\nInstalls ${PACKAGE_NAME} into a DSH profile and enables it.\nDefault profile: web. Default home: $DSH_HOME or ~/.dsh.`)
      process.exit(0)
    }
  }
  return options
}

/** Ensure the profile manifest and patch layer exist (mirrors dsh's initProfile). */
function ensureProfile(profileDir, profile) {
  mkdirSync(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    const bundles = WEB_TEMPLATE[profile] ?? ['@deepseek-ai/dsh-base']
    const manifest = {
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    console.log(`initialized profile ${profile} at ${profileDir}`)
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, '[]\n')
}

/** Append this package to dsh.profile.bundles unless already present. */
function registerBundle(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(PACKAGE_NAME)) return false
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, PACKAGE_NAME] } }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return true
}

function main() {
  const { profile, home } = parseArgs(process.argv.slice(2))
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles', profile)
  console.log(`target profile: ${profileDir}`)
  ensureProfile(profileDir, profile)

  console.log(`installing ${PACKAGE_NAME} into the profile...`)
  // On Windows npm ships as npm.cmd, which child_process cannot spawn
  // directly; route through cmd /c with a single command string (avoids the
  // shell:true argument-concatenation deprecation). Elsewhere npm is a
  // shebang script and spawns natively.
  const isWin = process.platform === 'win32'
  const result = isWin
    ? spawnSync('cmd', ['/d', '/s', '/c', `npm install --omit=peer ${PACKAGE_NAME}`], { cwd: profileDir, stdio: 'inherit' })
    : spawnSync('npm', ['install', '--omit=peer', PACKAGE_NAME], { cwd: profileDir, stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`failed to run npm: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error('npm install failed; the package was not registered.')
    process.exit(result.status ?? 1)
  }

  if (registerBundle(profileDir)) console.log(`registered ${PACKAGE_NAME} in the profile bundle list`)
  else console.log(`${PACKAGE_NAME} was already registered — nothing changed`)

  console.log(`\nDone. Restart DSH to load the plugin: dsh ${profile === 'web' ? 'web' : `--profile ${profile}`}`)
}

main()
