# OCWI Loader

Stable browser loader for the OCWI embeddable widget.

The loader is the short-cache file that customers embed. It loads the real widget runtime from the current `ocwi-core` npm CDN `latest` dist tag without requiring customers to update their snippets.

## Why This Exists

OCWI is embedded on many customer websites. Those websites should not need a webmaster change after every widget release.

The customer keeps one permanent script URL:

```html
<script src="https://cdn.jsdelivr.net/npm/ocwi-loader@latest/dist/loader.js" async></script>
```

The loader then resolves the current `ocwi-core@latest` bundle at runtime. For `latest`, it adds an hourly cache-busting query parameter so browsers do not keep an old already-downloaded core URL for days or weeks.

This updates OCWI on the next page load or reload. It does not hot-swap OCWI inside an already-open page.

## Customer Snippet

```html
<div id="ocwi-19" class="mount"></div>

<script>
  window.OCWI =
    window.OCWI ||
    function () {
      ;(window.OCWI.q = window.OCWI.q || []).push(arguments)
    }
  window.OCWI.q = window.OCWI.q || []
</script>
<script src="https://cdn.jsdelivr.net/npm/ocwi-loader@latest/dist/loader.js" async></script>
<script>
  window.OCWI('#ocwi-19', {
    api: {
      lumaUrl: 'https://luma.amca.cz/api/v1/config/<public-hash>/',
    },
  })
</script>
```

The snippet shape is intentionally close to the previous `ocwi-core` CDN snippet: the loader script carries `async` so neither the loader nor the core blocks the page parser. The first inline script installs a tiny synchronous queue-stub as `window.OCWI` so the call in the third script never throws, even though the `async` loader may not have run yet when it fires. The stub buffers calls on `window.OCWI.q`; the loader adopts and replays them once it runs. Keep the stub exactly as shown - it is required for the `async` snippet. A call made through the stub (before the loader runs) does not return a widget `.ready` handle.

The loader and the core are now served from the same origin, `cdn.jsdelivr.net`: the async loader tag opens that connection itself, so the origin is already warm by the time the loader injects the core. A `cdn.jsdelivr.net` preconnect in the page `<head>` still helps, but only by the small head start it gives over the loader tag's own fetch. The larger, longer-lived win is preconnecting your Luma origin - the widget does not touch it until the core runs its config fetch and opens the SSE stream, so warming its DNS/TCP/TLS up front takes that setup off the critical path. Emitting both hints (this is what the Luma snippet generator produces) can save roughly 100-300ms on a first visit:

```html
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="preconnect" href="https://luma.amca.cz" crossorigin>
```

Replace `luma.amca.cz` with the origin of your own Luma config URL.

## How It Works

- `loader.js` contains a build-time `ocwi-core` version. The default is `latest`.
- With the recommended `async` snippet, the loader injects the core bundle as a single `async` script, so it does not block the page parser:
  `https://cdn.jsdelivr.net/npm/ocwi-core@<version>/dist/ocwi.min.js`
- When the version is `latest`, the loader appends an hourly cache-busting query parameter:
  `?ocwi-loader-cache=<hour-bucket>`
- Inline `window.OCWI(...)` calls that run after the loader has executed but before the core has loaded are captured by a deferred proxy that queues them and replays them (resolving each returned `.ready` promise) once the core registers, so the snippet's call shape is unchanged. Calls that run before the loader itself executes (the common case on the `async` snippet) are captured earlier by the synchronous queue-stub in the snippet, which the loader adopts and drains into that same replay; those pre-loader calls run for their side effect but do not return a `.ready` handle.
- A plain non-async `<script src=".../loader.js"></script>` (the older snippet) instead uses `document.write` to inject a parser-blocking core. That path is kept only for backward compatibility; prefer the `async` snippet.
- Exact core versions remain immutable and cacheable. The `latest` URL changes hourly so browsers do not keep an old core bundle for days.
- When the loader is built with an exact `ocwi-core` version and its Subresource Integrity hash, the inserted core script carries `integrity="sha384-..."` and `crossorigin="anonymous"`, so the browser refuses a tampered bundle. `latest` is the explicit mutable opt-in and carries no integrity, because a moving tag has no stable hash.
- If the loader script has a CSP `nonce`, the loader copies it to the inserted core script.

Do not fetch the npm registry from browsers at runtime. That would add a registry round-trip to every startup; the loader resolves the core URL from its build-time version instead.

## Cache Behavior

There are two cache layers:

1. `loader.js` is served by jsDelivr from the `ocwi-loader@latest` npm tag (a version alias, edge-cached up to 7 days and purgeable via their API), so a new loader release reaches customers without a snippet change - purge on release to skip the propagation delay.
2. `ocwi-core@latest` is served by jsDelivr and may otherwise be cached by browsers for much longer.

The loader controls the second layer by changing the core URL once per hour:

```text
https://cdn.jsdelivr.net/npm/ocwi-core@latest/dist/ocwi.min.js?ocwi-loader-cache=493887
```

That means a user who reloads the page after the next hourly bucket receives a fresh URL and the browser is forced to check/download the current CDN result.

## Build

```bash
npm run build
```

By default, build values come from `package.json` under `ocwiLoader`. Release automation can override them, for example to pin a specific core version with its integrity hash:

```bash
OCWI_CORE_VERSION=1.1.2 \
OCWI_CORE_SRI="sha384-$(curl -fsSL https://cdn.jsdelivr.net/npm/ocwi-core@1.1.2/dist/ocwi.min.js | openssl dgst -sha384 -binary | openssl base64 -A)" \
npm run build
```

Pinning an exact version without an `OCWI_CORE_SRI` fails the build (an unverified pin is never shipped). Building `latest` is the explicit mutable opt-in and takes no SRI. `OCWI_CORE_SRI` can also be set as `ocwiLoader.coreSri` in `package.json`.

The generated artifact is:

```text
dist/loader.js
```

## Runtime Overrides

For debugging or staged rollout, the loader script supports these attributes:

```html
<script
  src="https://cdn.jsdelivr.net/npm/ocwi-loader@latest/dist/loader.js"
  data-ocwi-version="1.1.2"
></script>
```

```html
<script
  src="https://cdn.jsdelivr.net/npm/ocwi-loader@latest/dist/loader.js"
  data-ocwi-src="https://static.example.com/ocwi/ocwi.min.js"
></script>
```

`data-ocwi-src` wins over `data-ocwi-version`.

When `data-ocwi-version` is an exact version, the loader does not append the hourly cache-buster. When the effective version is `latest`, including the default, the cache-buster is appended automatically. `data-ocwi-src` is used exactly as provided.

A `data-ocwi-*` override that changes the core URL away from the pinned build (a different version, or `data-ocwi-src`/`-package`/`-cdn-base`/`-file`) drops the built-in integrity hash and warns, because that hash no longer matches the requested bundle. Overriding to the same pinned version keeps the integrity attribute.

## Demo

Open `demo/minimal.html` to see the smallest local demo snippet:

```html
<div id="ocwi-demo"></div>

<script src="../dist/loader.js"></script>
<script>
  window.OCWI('#ocwi-demo', {
    api: {
      lumaUrl: 'https://luma.amca.cz/api/v1/config/<public-hash>/',
    },
  })
</script>
```

Open `demo/latest.html` to test the default CDN `latest` dist tag with a small UI:

```html
<script src="../dist/loader.js"></script>
```

The page accepts a Luma config URL in the UI or as a query parameter:

```text
demo/latest.html?lumaUrl=https%3A%2F%2Fluma.amca.cz%2Fapi%2Fv1%2Fconfig%2F<public-hash>%2F
```

## Diagnostics

The loader exposes:

```js
window.OCWI_LOADER
```

Example fields:

```js
{
  loaderVersion: '0.1.0',
  corePackage: 'ocwi-core',
  coreVersion: 'latest',
  coreUrl: 'https://cdn.jsdelivr.net/npm/ocwi-core@latest/dist/ocwi.min.js?ocwi-loader-cache=493887',
  mode: 'dynamic',
  loaded: true
}
```

## Hosting

The loader is published to npm as `ocwi-loader` and served by jsDelivr from the `@latest` tag, the same delivery path as `ocwi-core`:

```text
https://cdn.jsdelivr.net/npm/ocwi-loader@latest/dist/loader.js
```

jsDelivr serves the moving `@latest` tag (edge-cached up to 7 days, purgeable via their API), so a new loader release reaches customers without a snippet change - purge `ocwi-loader@latest` on release to skip the propagation delay. Exact `ocwi-core@x.y.z` bundles the loader injects may be cached as immutable because the version is part of the URL. `ocwi-core@latest` is cache-busted hourly by the loader.

If you instead self-host `dist/loader.js` on your own controlled URL, keep it on a short cache (for example `Cache-Control: max-age=300, must-revalidate`) because it is the permanent customer entrypoint.

## Release Flow

1. Publish `ocwi-core@x.y.z`.
2. Ensure the npm `latest` dist tag points to that version.
3. Run `npm run test`.
4. Verify the hosted loader diagnostics show `coreVersion: 'latest'` and a current `coreUrl` with `ocwi-loader-cache`.
5. Purge the jsDelivr `latest` URL if the new core must appear before the CDN revalidates it. A loader release needs the same purge for `ocwi-loader@latest` (also edge-cached up to 7 days).

## Production Check

On a customer page or demo page, inspect:

```js
window.OCWI_LOADER
```

Expected production shape:

```js
{
  corePackage: 'ocwi-core',
  coreVersion: 'latest',
  coreUrl: 'https://cdn.jsdelivr.net/npm/ocwi-core@latest/dist/ocwi.min.js?ocwi-loader-cache=<hour-bucket>',
  mode: 'dynamic',
  loaded: true
}
```

If `coreVersion` is a fixed version such as `1.1.2`, that page is pinned and will not follow `latest` until the override is removed.

## Luma Snippet Configuration

In `luma-front`, point the existing snippet generator to the loader:

```env
VITE_OCWI_SCRIPT_URL=https://cdn.jsdelivr.net/npm/ocwi-loader@latest/dist/loader.js
```

The generator can keep producing the same HTML structure. Customers only receive the new script URL.
