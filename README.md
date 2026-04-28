# OCWI Loader

Stable browser loader for the OCWI embeddable widget.

The loader is the short-cache file that customers embed. It loads the real widget runtime from the current `ocwi-core` npm CDN `latest` dist tag without requiring customers to update their snippets.

## Why This Exists

OCWI is embedded on many customer websites. Those websites should not need a webmaster change after every widget release.

The customer keeps one permanent script URL:

```html
<script src="https://cdn.amca.cz/ocwi/loader.js"></script>
```

The loader then resolves the current `ocwi-core@latest` bundle at runtime. For `latest`, it adds an hourly cache-busting query parameter so browsers do not keep an old already-downloaded core URL for days or weeks.

This updates OCWI on the next page load or reload. It does not hot-swap OCWI inside an already-open page.

## Customer Snippet

```html
<div id="ocwi-19" class="mount"></div>

<script src="https://cdn.amca.cz/ocwi/loader.js"></script>
<script>
  window.OCWI('#ocwi-19', {
    api: {
      lumaUrl: 'https://luma.amca.cz/api/v1/config/<public-hash>/',
    },
  })
</script>
```

The snippet shape is intentionally the same as the previous `ocwi-core` CDN snippet. Only the first script URL changes.

## How It Works

- `loader.js` contains a build-time `ocwi-core` version. The default is `latest`.
- In normal classic script usage, it uses `document.write` to load:
  `https://cdn.jsdelivr.net/npm/ocwi-core@<version>/dist/ocwi.min.js`
- When the version is `latest`, the loader appends an hourly cache-busting query parameter:
  `?ocwi-loader-cache=<hour-bucket>`
- Because that inserted script is parser-blocking, the following inline `window.OCWI(...)` still sees the real synchronous OCWI API.
- Exact core versions remain immutable and cacheable. The `latest` URL changes hourly so browsers do not keep an old core bundle for days.
- If the loader script has a CSP `nonce`, the loader copies it to the inserted core script.

Do not fetch the npm registry from browsers at runtime. That would make the startup path asynchronous and would break the synchronous snippet contract.

## Cache Behavior

There are two cache layers:

1. `loader.js` is hosted by AMCA and should be short-cache.
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

By default, build values come from `package.json` under `ocwiLoader`. Release automation can override them, for example to pin a specific core version:

```bash
OCWI_CORE_VERSION=1.1.2 npm run build
```

The generated artifact is:

```text
dist/loader.js
```

## Runtime Overrides

For debugging or staged rollout, the loader script supports these attributes:

```html
<script
  src="https://cdn.amca.cz/ocwi/loader.js"
  data-ocwi-version="1.1.2"
></script>
```

```html
<script
  src="https://cdn.amca.cz/ocwi/loader.js"
  data-ocwi-src="https://static.example.com/ocwi/ocwi.min.js"
></script>
```

`data-ocwi-src` wins over `data-ocwi-version`.

When `data-ocwi-version` is an exact version, the loader does not append the hourly cache-buster. When the effective version is `latest`, including the default, the cache-buster is appended automatically. `data-ocwi-src` is used exactly as provided.

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
  mode: 'document.write',
  loaded: true
}
```

## Hosting

Host `dist/loader.js` on a controlled URL, for example:

```text
https://cdn.amca.cz/ocwi/loader.js
```

Recommended cache headers for the loader:

```http
Cache-Control: max-age=300, must-revalidate
```

The loader should stay on a short cache because it is the permanent customer entrypoint. Exact `ocwi-core@x.y.z` bundles may be cached as immutable because the version is part of the URL. `ocwi-core@latest` is cache-busted hourly by the loader.

## Release Flow

1. Publish `ocwi-core@x.y.z`.
2. Ensure the npm `latest` dist tag points to that version.
3. Run `npm run test`.
4. Verify the hosted loader diagnostics show `coreVersion: 'latest'` and a current `coreUrl` with `ocwi-loader-cache`.
5. Purge the jsDelivr `latest` URL if the new core must appear before the CDN revalidates it.

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
  mode: 'document.write',
  loaded: true
}
```

If `coreVersion` is a fixed version such as `1.1.2`, that page is pinned and will not follow `latest` until the override is removed.

## Luma Snippet Configuration

In `luma-front`, point the existing snippet generator to the loader:

```env
VITE_OCWI_SCRIPT_URL=https://cdn.amca.cz/ocwi/loader.js
```

The generator can keep producing the same HTML structure. Customers only receive the new script URL.
