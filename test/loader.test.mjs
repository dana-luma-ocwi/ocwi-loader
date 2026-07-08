import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loaderSource = await readFile(path.join(root, 'dist', 'loader.js'), 'utf8')
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
    vm.runInContext(loaderSource, context)
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

  const dynamic = runLoader({
    readyState: 'complete',
    attrs: {
      nonce: 'nonce-456',
    },
  })
  assert.equal(dynamic.appended[0].attrs.nonce, 'nonce-456')
}

{
  const { context, writes, appended, warnings } = runLoader({
    attrs: { async: true },
    appendLoads: true,
  })
  assert.equal(writes.length, 0)
  assert.equal(appended.length, 1)
  assert.equal(context.window.OCWI_LOADER.mode, 'dynamic')
  assert.equal(context.window.OCWI_LOADER.loaded, true)
  assert.ok(warnings.some((message) => message.includes('not executed as a parser-blocking')))
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

console.log('loader tests passed')
