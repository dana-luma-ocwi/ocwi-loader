import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildLoaderSource } from '../scripts/build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loaderSource = await readFile(path.join(root, 'dist', 'loader.js'), 'utf8')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const fixedNow = Date.UTC(2026, 3, 28, 15, 0, 0)
const cacheBucket = String(Math.floor(fixedNow / 3600000))

function makeScript(attrs = {}) {
  return {
    async: Boolean(attrs.async),
    defer: Boolean(attrs.defer),
    type: attrs.type || '',
    nonce: attrs.nonce || '',
    getAttribute(name) {
      return attrs[name] ?? ''
    },
  }
}

// One browser "page": a shared window/document plus a deferred fake timer
// (flushTimers drains queued callbacks) and a run() that re-executes the loader
// in the same context so multiple loader tags on one page can be modeled.
function createHarness({
  readyState = 'loading',
  appendLoads = false,
  seedWindow = {},
  noCreateElement = false,
  source = loaderSource,
} = {}) {
  const writes = []
  const appended = []
  const warnings = []
  const timers = []
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]))
    }
  }
  const context = {
    Date: FixedDate,
    window: {
      console: {
        warn(message) {
          warnings.push(message)
        },
      },
      setTimeout(callback) {
        timers.push(callback)
      },
    },
    document: null,
    console: {
      warn(message) {
        warnings.push(message)
      },
    },
  }

  const document = {
    currentScript: null,
    readyState,
    write(html) {
      writes.push(html)
    },
    createElement(tagName) {
      assert.equal(tagName, 'script')
      return {
        attrs: {},
        setAttribute(name, value) {
          this.attrs[name] = value
        },
      }
    },
    head: {
      appendChild(script) {
        appended.push(script)
        if (appendLoads) {
          context.window.OCWI = function OCWI() {
            return {
              updateConfig(value) {
                this.updated = value
              },
              getState() {
                return { ok: true }
              },
            }
          }
          script.onload()
        }
      },
    },
    getElementsByTagName() {
      return document.currentScript ? [document.currentScript] : []
    },
  }

  context.document = document
  context.window.document = document

  Object.assign(context.window, seedWindow)
  if (noCreateElement) delete document.createElement

  vm.createContext(context)

  function flushTimers() {
    const pending = timers.splice(0, timers.length)
    for (const callback of pending) callback()
  }

  function run({ attrs = {} } = {}) {
    document.currentScript = makeScript(attrs)
    vm.runInContext(source, context)
  }

  return { context, writes, appended, warnings, timers, flushTimers, run }
}

function runLoader({ attrs = {}, readyState = 'loading', ...rest } = {}) {
  const harness = createHarness({ readyState, ...rest })
  harness.run({ attrs })
  return harness
}

{
  const { context, writes, appended } = runLoader()
  assert.equal(appended.length, 0)
  assert.equal(writes.length, 1)
  assert.match(
    writes[0],
    /src="https:\/\/cdn\.jsdelivr\.net\/npm\/ocwi-core@latest\/dist\/ocwi\.min\.js\?ocwi-loader-cache=\d+"/,
  )
  assert.equal(context.window.OCWI_LOADER.coreVersion, 'latest')
  assert.equal(
    context.window.OCWI_LOADER.coreUrl,
    `https://cdn.jsdelivr.net/npm/ocwi-core@latest/dist/ocwi.min.js?ocwi-loader-cache=${cacheBucket}`,
  )
  assert.equal(context.window.OCWI_LOADER.mode, 'document.write')
  assert.doesNotMatch(writes[0], /""/)
}

{
  const { writes } = runLoader({
    attrs: {
      'data-ocwi-version': '2.0.0-beta.1',
    },
  })
  assert.match(writes[0], /ocwi-core@2\.0\.0-beta\.1\/dist\/ocwi\.min\.js/)
  assert.doesNotMatch(writes[0], /ocwi-loader-cache=/)
}

{
  const { writes, context } = runLoader({
    attrs: {
      'data-ocwi-version': 'latest',
    },
  })
  assert.match(
    writes[0],
    new RegExp(`ocwi-core@latest\\/dist\\/ocwi\\.min\\.js\\?ocwi-loader-cache=${cacheBucket}`),
  )
  assert.equal(context.window.OCWI_LOADER.coreVersion, 'latest')
}

{
  const { writes, context, warnings } = runLoader({
    attrs: {
      'data-ocwi-version': 'bad/version',
    },
  })
  assert.match(
    writes[0],
    new RegExp(`ocwi-core@latest\\/dist\\/ocwi\\.min\\.js\\?ocwi-loader-cache=${cacheBucket}`),
  )
  assert.equal(context.window.OCWI_LOADER.coreVersion, 'latest')
  assert.ok(warnings.some((message) => message.includes('Ignoring invalid OCWI core version')))
}

// (#13a): a mutable dist-tag other than 'latest' (e.g. 'beta', the advertised
// staged-rollout path) must still get the hourly cache-buster, or jsDelivr's long
// cache headers keep a stale bundle on pilot pages for days.
{
  const { writes, context } = runLoader({
    attrs: {
      'data-ocwi-version': 'beta',
    },
  })
  assert.match(writes[0], /ocwi-core@beta\/dist\/ocwi\.min\.js\?ocwi-loader-cache=/)
  assert.match(context.window.OCWI_LOADER.coreUrl, /ocwi-loader-cache=/)
}

// (#13b): a mixed-case dist-tag like 'Latest' is normalized to lowercase so the URL
// resolves - npm dist-tags are case-sensitive, so 'ocwi-core@Latest' would 404.
{
  const { writes, context } = runLoader({
    attrs: {
      'data-ocwi-version': 'Latest',
    },
  })
  assert.doesNotMatch(writes[0], /@Latest/)
  assert.doesNotMatch(context.window.OCWI_LOADER.coreUrl, /@Latest/)
  assert.equal(context.window.OCWI_LOADER.coreVersion, 'latest')
}

// (#13c): regression guard - an exact semver stays immutable (no cache-buster).
{
  const { writes, context } = runLoader({
    attrs: {
      'data-ocwi-version': '1.2.3',
    },
  })
  assert.match(writes[0], /ocwi-core@1\.2\.3\/dist\/ocwi\.min\.js/)
  assert.doesNotMatch(writes[0], /ocwi-loader-cache=/)
  assert.doesNotMatch(context.window.OCWI_LOADER.coreUrl, /ocwi-loader-cache=/)
}

{
  const { writes, context } = runLoader({
    attrs: {
      'data-ocwi-src': 'https://static.example.com/ocwi/custom.js',
    },
  })
  assert.match(writes[0], /src="https:\/\/static\.example\.com\/ocwi\/custom\.js"/)
  assert.equal(context.window.OCWI_LOADER.coreUrl, 'https://static.example.com/ocwi/custom.js')
  assert.doesNotMatch(writes[0], /ocwi-loader-cache=/)
}

{
  const { writes, appended } = runLoader({
    attrs: {
      nonce: 'nonce-123',
    },
  })
  assert.match(writes[0], /nonce="nonce-123"/)
  assert.doesNotMatch(writes[0], /""/)

  const dynamic = runLoader({
    readyState: 'complete',
    attrs: {
      nonce: 'nonce-456',
    },
  })
  assert.equal(dynamic.appended[0].attrs.nonce, 'nonce-456')
}

// Async is the first-class mode: the injected core script is async and the loader no longer warns against async.
{
  const { context, writes, appended, warnings } = runLoader({
    attrs: { async: true },
    appendLoads: true,
  })
  assert.equal(writes.length, 0)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].async, true)
  assert.equal(context.window.OCWI_LOADER.mode, 'dynamic')
  assert.equal(context.window.OCWI_LOADER.loaded, true)
  assert.ok(!warnings.some((message) => message.includes('not executed as a parser-blocking')))
}

{
  const { context, appended } = runLoader({
    readyState: 'complete',
  })
  assert.equal(appended.length, 1)
  assert.equal(typeof context.window.OCWI, 'function')
  const handle = context.window.OCWI('#chat', { api: { lumaUrl: 'https://luma.example/config' } })
  assert.equal(handle.getState(), null)
}

{
  const { context, appended } = runLoader({
    readyState: 'complete',
  })
  const calls = []
  const handle = context.window.OCWI('#chat')
  handle.updateConfig({ ui: { name: 'Queued' } })

  context.window.OCWI = function OCWI() {
    calls.push(Array.from(arguments))
    return {
      updates: [],
      updateConfig(value) {
        this.updates.push(value)
      },
      getState() {
        return { updates: this.updates.length }
      },
    }
  }

  appended[0].onload()

  const real = await handle.ready
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['#chat'])
  assert.deepEqual(real.updates, [{ ui: { name: 'Queued' } }])
  assert.deepEqual(handle.getState(), { updates: 1 })
}

// (#14a): once the core is loaded (target real, its updateConfig returns void like the
// real widget), a handle method must keep returning the handle so chained calls that
// worked during the load window do not start throwing after the core is real/cached.
{
  const { context, appended } = runLoader({ readyState: 'complete' })
  const handle = context.window.OCWI('#chat')

  context.window.OCWI = function OCWI() {
    return {
      updates: [],
      updateConfig(value) {
        this.updates.push(value)
      },
      getState() {
        return { updates: this.updates.length }
      },
    }
  }
  appended[0].onload()
  await handle.ready

  const chained = handle.updateConfig({ a: 1 }).updateConfig({ b: 2 })
  assert.equal(chained, handle, 'a post-load handle method must return the handle for chaining')
  assert.deepEqual(handle.getState(), { updates: 2 })
}

// (#14b): after the handle is rejected (core load failed), a later method call must warn
// and no-op, not silently queue onto a pending list that will never flush.
{
  const { context, appended, warnings } = runLoader({ readyState: 'complete' })
  const handle = context.window.OCWI('#chat')
  handle.ready.catch(() => {})

  appended[0].onerror()
  await Promise.resolve()

  const warningsBefore = warnings.length
  const returned = handle.updateConfig({ a: 1 })
  assert.equal(returned, handle, 'a rejected handle still returns the handle for a no-op chain')
  assert.ok(
    warnings.slice(warningsBefore).some((message) => message.includes('updateConfig')),
    'a method call on a rejected handle must warn',
  )
}

// Core bundle network failure (404 / 5xx): the browser fires the injected
// script's onerror, which must reject deferred handles, record a diagnostic on
// window.OCWI_LOADER, clear the loading lock, and warn. See src/loader.js:119-125.
{
  const { context, appended, warnings } = runLoader({
    readyState: 'complete',
  })
  assert.equal(appended.length, 1)

  const handle = context.window.OCWI('#chat')
  let rejection = null
  handle.ready.catch((error) => {
    rejection = error
  })

  appended[0].onerror()
  await Promise.resolve()

  assert.match(context.window.OCWI_LOADER.error, /Failed to load OCWI core bundle/)
  assert.match(context.window.OCWI_LOADER.error, /ocwi\.min\.js/)
  assert.equal(context.window.OCWI_LOADER.loaded, false)
  assert.equal(context.window.__OCWI_LOADER_LOADING__, false)
  assert.ok(rejection, 'deferred handle.ready should reject on core load failure')
  assert.match(rejection.message, /Failed to load OCWI core bundle/)
  assert.ok(warnings.some((message) => message.includes('Failed to load OCWI core bundle')))
}

// CSP-blocked core load: a Content-Security-Policy that rejects the injected
// script presents to the loader identically to a network failure (the script
// element fires onerror without executing). The graceful failure + diagnostic
// surface through window.OCWI_LOADER exactly as the 404/5xx case does. Once the
// failure is recorded, a NEW OCWI() handle must fail-fast (its .ready rejects
// immediately) rather than queue forever, since no further load is attempted.
{
  const { context, appended, warnings } = runLoader({
    readyState: 'complete',
  })
  assert.equal(appended.length, 1)

  appended[0].onerror()

  assert.match(context.window.OCWI_LOADER.error, /Failed to load OCWI core bundle/)
  assert.equal(context.window.OCWI_LOADER.loaded, false)
  assert.equal(context.window.__OCWI_LOADER_LOADING__, false)
  assert.ok(warnings.some((message) => message.includes('Failed to load OCWI core bundle')))

  const handle = context.window.OCWI('#chat')
  let rejection = null
  handle.ready.catch((error) => {
    rejection = error
  })
  await Promise.resolve()
  assert.ok(rejection, 'a handle created after a permanent load failure must fail-fast')
  assert.match(rejection.message, /Failed to load OCWI core bundle/)
  assert.equal(handle.getState(), null)
}

// G15 (#12): the core script loads (onload fires) but never registers window.OCWI
// (a wrong data-ocwi-src, or a core build that drops the IIFE global). With NO queued
// calls the failure must still surface - meta.error set and a warning - not silence.
{
  const { context, appended, warnings } = runLoader({ readyState: 'complete' })
  assert.equal(appended.length, 1)
  assert.equal(context.window.OCWI.__ocwiLoaderProxy, true)

  appended[0].onload()

  assert.match(context.window.OCWI_LOADER.error, /was not registered/)
  assert.equal(context.window.OCWI_LOADER.loaded, false)
  assert.equal(context.window.__OCWI_LOADER_LOADING__, false)
  assert.ok(warnings.some((message) => message.includes('was not registered')))
}

// G16 (#12): same onload-but-unregistered failure with a queued call. The queued
// handle must reject, and a NEW OCWI() call afterwards must fail-fast (its .ready
// rejects) via the recorded meta.error rather than queue forever behind a proxy
// nothing will ever replay.
{
  const { context, appended, warnings } = runLoader({ readyState: 'complete' })

  const queued = context.window.OCWI('#chat')
  let queuedRejection = null
  queued.ready.catch((error) => {
    queuedRejection = error
  })

  appended[0].onload()
  await Promise.resolve()

  assert.match(context.window.OCWI_LOADER.error, /was not registered/)
  assert.ok(warnings.some((message) => message.includes('was not registered')))
  assert.ok(queuedRejection, 'a handle queued before an unregistered load must reject')
  assert.match(queuedRejection.message, /was not registered/)

  const later = context.window.OCWI('#chat')
  let laterRejection = null
  later.ready.catch((error) => {
    laterRejection = error
  })
  await Promise.resolve()
  assert.ok(laterRejection, 'a handle created after an unregistered load must fail-fast')
  assert.match(laterRejection.message, /was not registered/)
}

// G9: already-loaded short-circuit. When window.OCWI is already the real widget
// fn, the loader records meta.loaded/already-loaded and returns without injecting.
{
  function realOcwi() {}
  const { context, writes, appended } = runLoader({
    readyState: 'complete',
    seedWindow: { OCWI: realOcwi },
  })
  assert.equal(writes.length, 0)
  assert.equal(appended.length, 0)
  assert.equal(context.window.OCWI_LOADER.loaded, true)
  assert.equal(context.window.OCWI_LOADER.mode, 'already-loaded')
  assert.equal(context.window.OCWI, realOcwi)
}

// G10: a concurrent second loader instance (the first set __OCWI_LOADER_LOADING__)
// installs the deferred proxy instead of injecting the core again.
{
  const { context, writes, appended } = runLoader({
    readyState: 'complete',
    seedWindow: { __OCWI_LOADER_LOADING__: true },
  })
  assert.equal(writes.length, 0)
  assert.equal(appended.length, 0)
  assert.equal(typeof context.window.OCWI, 'function')
  assert.equal(context.window.OCWI.__ocwiLoaderProxy, true)
}

// G13 (#11): a second loader tag on the same page must not overwrite the first
// tag's diagnostics for the core that is actually running. First tag loads core
// 1.2.3; a later tag pinned to 2.0.0 (which loads nothing) is recorded separately
// and warns, leaving coreVersion/coreUrl/mode still describing 1.2.3.
{
  const harness = createHarness({ readyState: 'complete', appendLoads: true })
  harness.run({ attrs: { 'data-ocwi-version': '1.2.3' } })
  assert.equal(harness.context.window.OCWI_LOADER.coreVersion, '1.2.3')
  assert.equal(harness.context.window.OCWI_LOADER.mode, 'dynamic')

  harness.run({ attrs: { 'data-ocwi-version': '2.0.0' } })
  assert.equal(harness.context.window.OCWI_LOADER.coreVersion, '1.2.3')
  assert.match(harness.context.window.OCWI_LOADER.coreUrl, /ocwi-core@1\.2\.3\//)
  assert.notEqual(harness.context.window.OCWI_LOADER.mode, 'pending')
  // ignoredInstances is allocated inside the vm realm, so compare its primitives
  // rather than deep-equalling arrays across realms (different Array.prototype).
  const ignored = harness.context.window.OCWI_LOADER.ignoredInstances
  assert.equal(ignored.length, 1)
  assert.equal(ignored[0].coreVersion, '2.0.0')
  assert.ok(
    harness.warnings.some((message) => message.includes('2.0.0') && message.includes('1.2.3')),
    'a version mismatch between loader tags must warn',
  )
}

// G14 (#11): while the first tag is still loading, a second tag must not regress
// mode from 'dynamic' back to 'pending'.
{
  const harness = createHarness({ readyState: 'complete', appendLoads: false })
  harness.run({ attrs: { 'data-ocwi-version': '1.2.3' } })
  assert.equal(harness.context.window.OCWI_LOADER.mode, 'dynamic')
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, true)

  harness.run({ attrs: { 'data-ocwi-version': '2.0.0' } })
  assert.equal(harness.context.window.OCWI_LOADER.mode, 'dynamic')
  assert.equal(harness.context.window.OCWI_LOADER.coreVersion, '1.2.3')
}

// G11: data-ocwi-package / -cdn-base / -file resolve into the core URL (a concrete
// version means no cache-buster).
{
  const { context } = runLoader({
    attrs: {
      'data-ocwi-package': 'my-core',
      'data-ocwi-cdn-base': 'https://cdn.test/base/',
      'data-ocwi-file': '/dist/bundle.js',
      'data-ocwi-version': '1.2.3',
    },
  })
  assert.equal(context.window.OCWI_LOADER.coreUrl, 'https://cdn.test/base/my-core@1.2.3/dist/bundle.js')
  assert.equal(context.window.OCWI_LOADER.corePackage, 'my-core')
}

// G12: handle.config = x set before load is queued, then flushed onto the real
// target after the core loads.
{
  const { context, appended } = runLoader({ readyState: 'complete' })
  const handle = context.window.OCWI('#chat')
  handle.config = { ui: { name: 'Queued config' } }

  context.window.OCWI = function OCWI() {
    return { config: undefined, getState() { return null } }
  }
  appended[0].onload()
  await handle.ready

  assert.deepEqual(handle.config, { ui: { name: 'Queued config' } })
}

// G17: missing document.createElement in dynamic mode -> failDeferredProxy. No
// script is appended, and an already-queued deferred handle is rejected.
{
  let rejected = null
  const { appended } = runLoader({
    readyState: 'complete',
    noCreateElement: true,
    seedWindow: {
      __OCWI_LOADER_QUEUE__: [{ handle: { reject(error) { rejected = error } } }],
    },
  })
  assert.equal(appended.length, 0)
  assert.ok(rejected, 'a queued handle must be rejected when createElement is missing')
  assert.match(rejected.message, /createElement/)
}

// H1: document.write path. pollForLoaded queues a real timer; the load outcome
// (meta.loaded, loading lock) settles only after the core registers window.OCWI
// and the queued poll is flushed - hence register-then-flush ordering below.
{
  const { context, writes, timers, flushTimers } = runLoader({ readyState: 'loading' })
  assert.equal(writes.length, 1)
  assert.equal(context.window.OCWI_LOADER.mode, 'document.write')
  assert.equal(timers.length, 1, 'pollForLoaded must schedule a real deferred timer')
  assert.equal(context.window.OCWI_LOADER.loaded, false)
  assert.equal(context.window.__OCWI_LOADER_LOADING__, true)

  context.window.OCWI = function realWidget() {}
  flushTimers()

  assert.equal(context.window.OCWI_LOADER.loaded, true)
  assert.equal(context.window.__OCWI_LOADER_LOADING__, false)
}

// H2: two loader tags on one page. The second run must detect the in-flight load
// and not write or inject the core again, keeping a single shared proxy.
{
  const harness = runLoader({ readyState: 'loading' })
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, true)
  const proxy = harness.context.window.OCWI
  assert.equal(proxy.__ocwiLoaderProxy, true)

  harness.run({ attrs: { nonce: 'second-tag' } })

  assert.equal(harness.writes.length, 1, 'second loader tag must not document.write the core again')
  assert.equal(harness.appended.length, 0, 'second loader tag must not inject a second core script')
  assert.equal(harness.context.window.OCWI, proxy, 'both tags share one deferred proxy')

  harness.context.window.OCWI = function realWidget() {}
  harness.flushTimers()
  assert.equal(harness.context.window.OCWI_LOADER.loaded, true)
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, false)
}

// H3 (issue #6): document.write path, the core script never registers window.OCWI
// (a 404/CSP block the parser-inserted script cannot report). The bounded re-poll
// must surface the failure - set meta.error, clear the loading lock, and reject
// queued handles - instead of hanging with __OCWI_LOADER_LOADING__ stuck true.
{
  const harness = runLoader({ readyState: 'loading' })
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.context.window.OCWI_LOADER.mode, 'document.write')

  const handle = harness.context.window.OCWI('#chat')
  let rejection = null
  handle.ready.catch((error) => {
    rejection = error
  })

  let guard = 200
  while (harness.context.window.__OCWI_LOADER_LOADING__ && guard-- > 0) {
    harness.flushTimers()
  }
  await Promise.resolve()

  assert.equal(harness.context.window.OCWI_LOADER.loaded, false)
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, false)
  assert.match(harness.context.window.OCWI_LOADER.error, /OCWI core bundle/)
  assert.ok(rejection, 'a doc.write load that never registers the core must reject queued handles')
  assert.match(rejection.message, /OCWI core bundle/)
}

// H4 (issue #6): document.write success flushes queued handles too. A call queued
// on the proxy before the core registers must resolve once the poll observes the
// real widget, mirroring the dynamic path's onload replay.
{
  const harness = runLoader({ readyState: 'loading' })
  const handle = harness.context.window.OCWI('#chat')

  harness.context.window.OCWI = function realWidget() {
    return {
      getState() {
        return { ok: true }
      },
    }
  }
  harness.flushTimers()

  const real = await handle.ready
  assert.equal(harness.context.window.OCWI_LOADER.loaded, true)
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, false)
  assert.deepEqual(real.getState(), { ok: true })
}

// D1 (issue #7): dynamic path, the injected core script fires NEITHER onload nor
// onerror - a stalled request (connection hangs, no response, no error). Without a
// watchdog the queued handles and .ready wait forever. The bounded watchdog must
// surface the stall - set meta.error, clear the loading lock, reject queued handles,
// and warn - but only AFTER the watchdog interval, never synchronously.
{
  const harness = runLoader({ readyState: 'complete' })
  assert.equal(harness.appended.length, 1)
  assert.equal(harness.context.window.OCWI_LOADER.mode, 'dynamic')

  const handle = harness.context.window.OCWI('#chat')
  let rejection = null
  handle.ready.catch((error) => {
    rejection = error
  })

  // Neither onload nor onerror fires: the stall must NOT settle before the watchdog.
  await Promise.resolve()
  assert.equal(rejection, null, 'a stalled load must not settle before the watchdog fires')
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, true)
  assert.equal(harness.context.window.OCWI_LOADER.error, undefined)
  assert.equal(harness.timers.length, 1, 'the dynamic path must arm a bounded watchdog timer')

  harness.flushTimers()
  await Promise.resolve()

  assert.equal(harness.context.window.OCWI_LOADER.loaded, false)
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, false)
  assert.match(harness.context.window.OCWI_LOADER.error, /OCWI core bundle/)
  assert.ok(rejection, 'a stalled dynamic load must reject queued handles after the watchdog')
  assert.match(rejection.message, /OCWI core bundle/)
  assert.ok(harness.warnings.some((message) => message.includes('OCWI core bundle')))
}

// D2 (issue #7): a normal dynamic onload must NOT let the watchdog later fire a
// spurious timeout. After the core loads, draining the timer queue is a no-op:
// meta.error stays unset and the load remains successful.
{
  const harness = runLoader({ readyState: 'complete', appendLoads: true })
  assert.equal(harness.context.window.OCWI_LOADER.loaded, true)
  assert.equal(harness.context.window.__OCWI_LOADER_LOADING__, false)

  harness.flushTimers()
  await Promise.resolve()

  assert.equal(harness.context.window.OCWI_LOADER.loaded, true)
  assert.equal(harness.context.window.OCWI_LOADER.error, undefined)
}

// --- Issue #5: exact-version pin + Subresource Integrity + immutable caching ---

// sha384 of the ASCII string "ocwi-loader-sri-fixture": a real, reproducible hash
// used only as a format-valid FIXTURE. No real ocwi-core bundle hash is committed
// into the loader - that is a per-release value the build/CD supplies.
const PINNED_VERSION = '1.2.3'
const FIXTURE_SRI = 'sha384-s06eU2HcZfVJPzEgrE15N3hwPYkyZTM8KQUHrz4O1YAsF4WcLltOEVgVnT0hyM5b'
const pinnedSource = await buildLoaderSource(pkg, {
  OCWI_CORE_VERSION: PINNED_VERSION,
  OCWI_CORE_SRI: FIXTURE_SRI,
})
const pinnedVersionPattern = new RegExp('ocwi-core@' + PINNED_VERSION.replace(/\./g, '\\.') + '/')

// P1: document.write path on a pinned build - exact version, integrity + crossorigin,
// and no cache-buster (the exact URL is immutable).
{
  const { writes } = runLoader({ readyState: 'loading', source: pinnedSource })
  assert.match(writes[0], pinnedVersionPattern)
  assert.doesNotMatch(writes[0], /@latest/)
  assert.doesNotMatch(writes[0], /ocwi-loader-cache=/)
  assert.ok(writes[0].includes('integrity="' + FIXTURE_SRI + '"'))
  assert.match(writes[0], /crossorigin="anonymous"/)
}

// P2: dynamic path on a pinned build carries the same integrity + crossorigin.
{
  const { appended } = runLoader({ readyState: 'complete', source: pinnedSource })
  assert.equal(appended.length, 1)
  assert.match(appended[0].src, pinnedVersionPattern)
  assert.doesNotMatch(appended[0].src, /ocwi-loader-cache=/)
  assert.equal(appended[0].attrs.integrity, FIXTURE_SRI)
  assert.equal(appended[0].attrs.crossorigin, 'anonymous')
}

// P3: latest stays an explicit opt-in even on a pinned build - the cache-buster
// returns and no integrity is emitted (a mutable tag has no stable hash).
{
  const { writes } = runLoader({
    readyState: 'loading',
    attrs: { 'data-ocwi-version': 'latest' },
    source: pinnedSource,
  })
  assert.match(writes[0], /ocwi-core@latest\//)
  assert.match(writes[0], /ocwi-loader-cache=/)
  assert.doesNotMatch(writes[0], /integrity=/)
  assert.doesNotMatch(writes[0], /crossorigin=/)
}

// P4: a data-ocwi-* override changes the artifact, so the pinned hash no longer
// matches. The loader drops it and warns rather than attaching a wrong hash.
{
  const { appended, warnings } = runLoader({
    readyState: 'complete',
    attrs: { 'data-ocwi-version': '9.9.9' },
    source: pinnedSource,
  })
  assert.equal(appended[0].attrs.integrity, undefined)
  assert.equal(appended[0].attrs.crossorigin, undefined)
  assert.ok(warnings.some((message) => message.includes('Subresource Integrity')))
}

// P5: overriding to the SAME pinned version keeps the SRI (the artifact is identical).
{
  const { appended } = runLoader({
    readyState: 'complete',
    attrs: { 'data-ocwi-version': PINNED_VERSION },
    source: pinnedSource,
  })
  assert.equal(appended[0].attrs.integrity, FIXTURE_SRI)
  assert.equal(appended[0].attrs.crossorigin, 'anonymous')
}

// P6: the build fails loudly rather than shipping an unverifiable or contradictory
// pin (no silent fallback to an unpinned / unhashed core).
await assert.rejects(
  buildLoaderSource(pkg, { OCWI_CORE_VERSION: PINNED_VERSION }),
  /requires OCWI_CORE_SRI/,
)
await assert.rejects(
  buildLoaderSource(pkg, { OCWI_CORE_VERSION: 'latest', OCWI_CORE_SRI: FIXTURE_SRI }),
  /cannot be combined with coreVersion 'latest'/,
)
await assert.rejects(
  buildLoaderSource(pkg, { OCWI_CORE_VERSION: PINNED_VERSION, OCWI_CORE_SRI: 'not-a-real-sri' }),
  /not a valid Subresource Integrity/,
)

console.log('loader tests passed')
