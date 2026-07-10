import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { minify } from 'terser'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(root, 'package.json')
const srcPath = path.join(root, 'src', 'loader.js')
const distDir = path.join(root, 'dist')
const distPath = path.join(distDir, 'loader.js')

const SRI_PATTERN = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/

// dist/loader.js is the permanently-embedded, parser-blocking script on every customer
// page, so its shipped bytes are guarded. The build fails if the gzipped artifact grows
// past this budget (current minified size ~2.2 KB); bump it only as a deliberate decision.
export const GZIP_BUDGET_BYTES = 3072

// Mirror of isLatestVersion() in src/loader.js; keep the two in sync (the inlined IIFE loader cannot share a module with the build).
function isLatest(version) {
  return String(version || '').toLowerCase() === 'latest'
}

// Resolves and validates the core pin. Fails loudly so a release can never ship an
// exact version without a matching SRI (an unverified pin) or a mutable 'latest'
// tag carrying a stale hash. 'latest' is the explicit mutable opt-in and takes no
// SRI, because the hash of a moving tag is unknown by design.
export function resolveCoreConfig(pkg, env = {}) {
  const config = pkg.ocwiLoader ?? {}
  const corePackage = env.OCWI_CORE_PACKAGE || config.corePackage
  const coreVersion = env.OCWI_CORE_VERSION || config.coreVersion
  const coreFile = env.OCWI_CORE_FILE || config.coreFile
  const cdnBase = env.OCWI_CDN_BASE || config.cdnBase
  const coreSri = String(env.OCWI_CORE_SRI ?? config.coreSri ?? '').trim()

  if (coreSri && isLatest(coreVersion)) {
    throw new Error(
      "ocwi-loader build: OCWI_CORE_SRI cannot be combined with coreVersion 'latest' - a mutable tag has no stable hash. Pin an exact version, or drop the SRI for the mutable opt-in.",
    )
  }
  if (coreSri && !SRI_PATTERN.test(coreSri)) {
    throw new Error(
      `ocwi-loader build: OCWI_CORE_SRI '${coreSri}' is not a valid Subresource Integrity value (expected e.g. sha384-<base64>).`,
    )
  }
  if (!coreSri && !isLatest(coreVersion)) {
    throw new Error(
      `ocwi-loader build: pinning ocwi-core@${coreVersion} requires OCWI_CORE_SRI (sha384-...). Derive it from the exact published bundle, for example:\n` +
        `  curl -fsSL "${cdnBase}/${corePackage}@${coreVersion}/${coreFile}" | openssl dgst -sha384 -binary | openssl base64 -A\n` +
        `then prefix 'sha384-'. Or build coreVersion 'latest' for the explicit mutable opt-in.`,
    )
  }

  return { corePackage, coreVersion, coreFile, cdnBase, coreSri }
}

export async function buildLoaderSource(pkg, env = {}) {
  const resolved = resolveCoreConfig(pkg, env)

  const replacements = {
    __OCWI_LOADER_VERSION__: JSON.stringify(pkg.version),
    __OCWI_CORE_PACKAGE__: JSON.stringify(resolved.corePackage),
    __OCWI_CORE_VERSION__: JSON.stringify(resolved.coreVersion),
    __OCWI_CORE_FILE__: JSON.stringify(resolved.coreFile),
    __OCWI_CDN_BASE__: JSON.stringify(resolved.cdnBase),
    __OCWI_CORE_SRI__: JSON.stringify(resolved.coreSri),
  }

  let source = await readFile(srcPath, 'utf8')
  for (const [token, value] of Object.entries(replacements)) {
    source = source.split(token).join(value)
  }

  const minified = await minify(source, {
    compress: true,
    mangle: true,
    format: { comments: false },
  })
  if (minified.error) throw minified.error

  const banner = [
    `/*! ${pkg.name} v${pkg.version}`,
    ` * core: ${resolved.corePackage}@${resolved.coreVersion}${resolved.coreSri ? ' (SRI-pinned)' : ''}`,
    ' * This file is generated from src/loader.js.',
    ' */',
    '',
  ].join('\n')

  return banner + minified.code
}

async function main() {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  const output = await buildLoaderSource(pkg, process.env)

  await mkdir(distDir, { recursive: true })
  await writeFile(distPath, output, 'utf8')

  const gzipBytes = gzipSync(output).length
  if (gzipBytes > GZIP_BUDGET_BYTES) {
    throw new Error(
      `ocwi-loader build: dist/loader.js is ${gzipBytes} B gzipped, over the ${GZIP_BUDGET_BYTES} B budget for the parser-blocking entrypoint. Trim the loader or raise GZIP_BUDGET_BYTES deliberately.`,
    )
  }

  console.log(
    `Built ${path.relative(root, distPath)} (${gzipBytes} B gzipped, budget ${GZIP_BUDGET_BYTES} B)`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
