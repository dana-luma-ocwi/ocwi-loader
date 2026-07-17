(function () {
  'use strict';

  var LOADER_VERSION = __OCWI_LOADER_VERSION__;
  var DEFAULT_CORE_PACKAGE = __OCWI_CORE_PACKAGE__;
  var DEFAULT_CORE_VERSION = __OCWI_CORE_VERSION__;
  var DEFAULT_CORE_FILE = __OCWI_CORE_FILE__;
  var DEFAULT_CDN_BASE = __OCWI_CDN_BASE__;
  var DEFAULT_CORE_SRI = __OCWI_CORE_SRI__;
  var GLOBAL_NAME = 'OCWI';
  var META_NAME = 'OCWI_LOADER';
  var CORE_POLL_INTERVAL_MS = 250;
  var CORE_POLL_MAX_ATTEMPTS = 40;
  var DYNAMIC_LOAD_TIMEOUT_MS = 10000;

  var root = typeof window !== 'undefined' ? window : globalThis;
  var doc = root.document;
  var currentScript = getCurrentScript();
  var corePackage = readAttr(currentScript, 'data-ocwi-package') || DEFAULT_CORE_PACKAGE;
  var versionAttr = normalizeVersion(readAttr(currentScript, 'data-ocwi-version'));
  var coreVersion = versionAttr || DEFAULT_CORE_VERSION;
  var coreUrl = resolveCoreUrl(currentScript, corePackage, coreVersion);
  var coreSri = resolveCoreSri(coreUrl, coreVersion);
  var scriptNonce = readNonce(currentScript);
  var meta = (root[META_NAME] = root[META_NAME] || {});
  var alreadyLoaded = isRealOcwi(root[GLOBAL_NAME]);

  // The first loader instance to run owns the descriptive meta; a second tag on the
  // same page (e.g. a pinned snippet next to a default one) must not rewrite the
  // version/URL/mode of the core that is actually running, or diagnostics lie. Later
  // instances are recorded separately and warned on a version mismatch instead.
  if (meta.startedAt) {
    recordSecondaryInstance();
  } else {
    meta.loaderVersion = LOADER_VERSION;
    meta.corePackage = corePackage;
    meta.coreVersion = coreVersion;
    meta.coreUrl = coreUrl;
    if (coreSri) meta.coreSri = coreSri;
    meta.loaded = alreadyLoaded;
    meta.mode = alreadyLoaded ? 'already-loaded' : 'pending';
    meta.startedAt = new Date().toISOString();
  }

  if (alreadyLoaded) return;

  if (root.__OCWI_LOADER_LOADING__) {
    installDeferredProxy();
    return;
  }

  root.__OCWI_LOADER_LOADING__ = true;

  if (canUseDocumentWrite(currentScript)) {
    meta.mode = 'document.write';
    installDeferredProxy();
    doc.write(
      '<script src="' +
        escapeHtmlAttr(coreUrl) +
        '" data-ocwi-core="true" data-ocwi-core-version="' +
        escapeHtmlAttr(meta.coreVersion) +
        '"' +
        (coreSri ? ' integrity="' + escapeHtmlAttr(coreSri) + '" crossorigin="anonymous"' : '') +
        (scriptNonce ? ' nonce="' + escapeHtmlAttr(scriptNonce) + '"' : '') +
        '><\/script>'
    );
    pollForLoaded();
    return;
  }

  // Async injection is the recommended path; the document.write branch above is the legacy fallback.
  meta.mode = 'dynamic';
  installDeferredProxy();
  injectDynamicScript(coreUrl);

  function resolveCoreUrl(script, packageName, version) {
    var explicitSrc = readAttr(script, 'data-ocwi-src');
    if (explicitSrc) return explicitSrc;

    var coreFile = stripSlashes(readAttr(script, 'data-ocwi-file') || DEFAULT_CORE_FILE);
    var cdnBase = stripTrailingSlash(readAttr(script, 'data-ocwi-cdn-base') || DEFAULT_CDN_BASE);
    var coreUrl = cdnBase + '/' + packageName + '@' + version + '/' + coreFile;

    // Only an exact semver is immutable on jsDelivr; every dist-tag (latest, beta,
    // next) is mutable and served with long cache headers, so it must carry the
    // hourly buster or a stale bundle sticks in the browser for days.
    return isExactVersion(version) ? coreUrl : appendCacheBuster(coreUrl);
  }

  // The baked hash matches only the exact pinned bundle, so any override that
  // changes the effective core URL invalidates it: attach it to the canonical URL only.
  function resolveCoreSri(coreUrl, version) {
    if (!DEFAULT_CORE_SRI) return '';
    if (isLatestVersion(version)) return '';

    var canonical = resolveCoreUrl(null, DEFAULT_CORE_PACKAGE, DEFAULT_CORE_VERSION);
    if (coreUrl === canonical) return DEFAULT_CORE_SRI;

    warn(
      'A data-ocwi-* override changed the core URL, so the pinned Subresource ' +
        'Integrity hash was not applied to the injected script.'
    );
    return '';
  }

  function getCurrentScript() {
    if (!doc) return null;
    if (doc.currentScript) return doc.currentScript;

    var scripts = doc.getElementsByTagName ? doc.getElementsByTagName('script') : [];
    return scripts && scripts.length ? scripts[scripts.length - 1] : null;
  }

  function canUseDocumentWrite(script) {
    if (!doc || typeof doc.write !== 'function') return false;
    if (doc.readyState && doc.readyState !== 'loading') return false;
    if (!script) return true;
    if (script.async || script.defer) return false;

    var type = (script.type || '').trim().toLowerCase();
    return !type || type === 'text/javascript' || type === 'application/javascript';
  }

  function injectDynamicScript(src) {
    if (!doc || !doc.createElement) {
      failDeferredProxy(new Error('OCWI loader cannot find document.createElement.'));
      return;
    }

    var script = doc.createElement('script');
    script.src = src;
    // Async: a single injected core script has nothing to order against, so blocking
    // the parser buys nothing. Inline window.OCWI(...) calls still work because the
    // deferred proxy queues and replays them once the core registers.
    script.async = true;
    script.setAttribute('data-ocwi-core', 'true');
    script.setAttribute('data-ocwi-core-version', meta.coreVersion);
    if (coreSri) {
      script.setAttribute('integrity', coreSri);
      script.setAttribute('crossorigin', 'anonymous');
    }
    if (scriptNonce) {
      script.setAttribute('nonce', scriptNonce);
      try {
        script.nonce = scriptNonce;
      } catch (_) {
        // Some browsers expose nonce as a protected reflected property.
      }
    }

    script.onload = function () {
      markCoreLoaded();
    };

    script.onerror = function () {
      markCoreError(new Error('Failed to load OCWI core bundle: ' + src));
    };

    var target = doc.head || doc.documentElement || doc.body;
    if (!target || !target.appendChild) {
      script.onerror();
      return;
    }

    armLoadWatchdog(src);
    target.appendChild(script);
  }

  // A stalled request (connection hangs, no response, no error) fires neither
  // onload nor onerror, so without a bound the deferred proxy queues forever.
  function armLoadWatchdog(src) {
    if (!root.setTimeout) return;
    root.setTimeout(function () {
      if (!root.__OCWI_LOADER_LOADING__) return;
      markCoreError(coreTimeoutError(src));
    }, DYNAMIC_LOAD_TIMEOUT_MS);
  }

  function coreTimeoutError(url) {
    return new Error('Timed out waiting for OCWI core bundle to load: ' + url);
  }

  function installDeferredProxy() {
    if (isRealOcwi(root[GLOBAL_NAME])) return;
    if (root[GLOBAL_NAME] && root[GLOBAL_NAME].__ocwiLoaderProxy) return;

    var queue = root.__OCWI_LOADER_QUEUE__ || [];
    root.__OCWI_LOADER_QUEUE__ = queue;

    adoptStubQueue(queue);

    var proxy = function () {
      var handle = createDeferredHandle();
      if (meta.error) {
        handle.reject(new Error(meta.error));
        return handle.publicHandle;
      }
      queue.push({
        args: Array.prototype.slice.call(arguments),
        handle: handle
      });
      return handle.publicHandle;
    };

    proxy.__ocwiLoaderProxy = true;
    proxy.__ocwiLoaderQueue = queue;
    root[GLOBAL_NAME] = proxy;
  }

  // The documented async snippet installs a tiny synchronous stub as window.OCWI
  // before loader.js runs, so inline OCWI(...) calls made while the loader is still
  // downloading do not throw; the stub buffers each call's raw arguments on its .q
  // array. Migrate those buffered calls into the deferred queue (ahead of any call
  // that later lands on the proxy) so they replay in original order once the core
  // registers, then let the proxy replace the stub. A stub call returned undefined,
  // so these pre-load calls have no .ready handle to observe; replay is side-effect
  // only, and a failed load still surfaces globally via meta.error and a warning.
  function adoptStubQueue(queue) {
    var stub = root[GLOBAL_NAME];
    if (!isStub(stub)) return;

    for (var i = 0; i < stub.q.length; i += 1) {
      queue.push({
        args: Array.prototype.slice.call(stub.q[i]),
        handle: { resolve: noop, reject: noop }
      });
    }
    stub.q.length = 0;
  }

  function recordSecondaryInstance() {
    var instances = meta.ignoredInstances || (meta.ignoredInstances = []);
    instances.push({ coreVersion: coreVersion, coreUrl: coreUrl });

    if (coreVersion !== meta.coreVersion) {
      warn(
        'A second OCWI loader tag requests core version "' + coreVersion +
          '" but version "' + meta.coreVersion + '" is already ' +
          (alreadyLoaded ? 'loaded' : 'loading') +
          '; the first tag wins and this one is ignored.'
      );
    }
  }

  function replayDeferredQueue() {
    var queue = root.__OCWI_LOADER_QUEUE__;
    var realOcwi = root[GLOBAL_NAME];

    // A core that executes without registering window.OCWI is a permanent failure,
    // so record it before the empty-queue early return: otherwise, with nothing
    // queued, no meta.error/warn surfaces and later OCWI() calls queue forever
    // behind the proxy (its fail-fast only triggers once meta.error is set).
    if (!isRealOcwi(realOcwi)) {
      markCoreError(new Error('OCWI core loaded but window.OCWI was not registered.'));
      return;
    }

    if (!queue || !queue.length) return;

    for (var i = 0; i < queue.length; i += 1) {
      try {
        queue[i].handle.resolve(realOcwi.apply(root, queue[i].args));
      } catch (error) {
        queue[i].handle.reject(error);
      }
    }

    queue.length = 0;
  }

  function failDeferredProxy(error) {
    var queue = root.__OCWI_LOADER_QUEUE__;
    if (!queue) return;

    for (var i = 0; i < queue.length; i += 1) {
      queue[i].handle.reject(error);
    }
    queue.length = 0;
  }

  // Shared success/failure bookkeeping for both injection paths, so the dynamic
  // onload/onerror and the document.write poll stay in lockstep.
  function markCoreLoaded() {
    // A late onload after the watchdog already timed out (or any settle that flipped
    // the loading flag) must be inert: otherwise it flips meta.loaded/loadedAt back on
    // while markCoreError has already recorded meta.error, leaving contradictory
    // loaded:true+error diagnostics and a permanently rejected pre-timeout handle.
    if (!root.__OCWI_LOADER_LOADING__) return;
    root.__OCWI_LOADER_LOADING__ = false;
    meta.loaded = isRealOcwi(root[GLOBAL_NAME]);
    // Stamp loadedAt only on a confirmed-successful load: an onload that resolves to a
    // missing global delegates to replayDeferredQueue -> markCoreError, so a loadedAt
    // here would sit next to meta.error on a load that never actually succeeded.
    if (meta.loaded) meta.loadedAt = new Date().toISOString();
    replayDeferredQueue();
  }

  function markCoreError(error) {
    meta.error = error.message;
    root.__OCWI_LOADER_LOADING__ = false;
    failDeferredProxy(error);
    warn(error.message);
  }

  function createDeferredHandle() {
    var target = null;
    var pending = [];
    var rejected = false;
    var settleReady;
    var rejectReady;
    var ready =
      typeof Promise === 'function'
        ? new Promise(function (resolve, reject) {
            settleReady = resolve;
            rejectReady = reject;
          })
        : null;

    var publicHandle = {
      ready: ready,
      updateConfig: function () {
        return callOrQueue('updateConfig', arguments);
      },
      setInitialLumaStatus: function () {
        return callOrQueue('setInitialLumaStatus', arguments);
      },
      getState: function () {
        return target && typeof target.getState === 'function' ? target.getState() : null;
      },
      destroy: function () {
        return callOrQueue('destroy', arguments);
      }
    };

    try {
      Object.defineProperty(publicHandle, 'config', {
        configurable: true,
        enumerable: true,
        get: function () {
          return target ? target.config : undefined;
        },
        set: function (value) {
          if (target) {
            target.config = value;
            return;
          }
          pending.push({ method: '__setConfig', args: [value] });
        }
      });
    } catch (_) {
      // Older browsers still get method queuing; config passthrough is best-effort.
    }

    return {
      publicHandle: publicHandle,
      resolve: function (realTarget) {
        target = realTarget;
        flushPending();
        if (settleReady) settleReady(realTarget);
      },
      reject: function (error) {
        rejected = true;
        if (rejectReady) rejectReady(error);
      }
    };

    // The real widget's methods return void, so forward for the side effect but always
    // return publicHandle: the return shape must not flip between the queued (pre-load)
    // and forwarded (post-load) paths, or chained calls throw once the core is real.
    function callOrQueue(method, argsLike) {
      if (rejected) {
        warn('OCWI ' + method + '() ignored: the core failed to load.');
        return publicHandle;
      }

      if (target && typeof target[method] === 'function') {
        target[method].apply(target, Array.prototype.slice.call(argsLike));
        return publicHandle;
      }

      pending.push({
        method: method,
        args: Array.prototype.slice.call(argsLike)
      });

      return publicHandle;
    }

    function flushPending() {
      for (var i = 0; i < pending.length; i += 1) {
        var item = pending[i];
        if (item.method === '__setConfig') {
          target.config = item.args[0];
          continue;
        }
        if (typeof target[item.method] === 'function') {
          target[item.method].apply(target, item.args);
        }
      }
      pending.length = 0;
    }
  }

  // A parser-inserted core <script> has no element to attach onerror to, so the
  // document.write path detects success/failure by a bounded re-poll instead. The
  // first check runs immediately (the parser-blocking core usually registers at
  // once); retries back off, and exhausting the budget surfaces a timeout.
  function pollForLoaded() {
    if (!root.setTimeout) return;

    var attemptsLeft = CORE_POLL_MAX_ATTEMPTS;
    (function tick(first) {
      root.setTimeout(function () {
        if (isRealOcwi(root[GLOBAL_NAME])) {
          markCoreLoaded();
          return;
        }
        if (attemptsLeft-- > 0) {
          tick(false);
          return;
        }
        markCoreError(coreTimeoutError(coreUrl));
      }, first ? 0 : CORE_POLL_INTERVAL_MS);
    })(true);
  }

  function isRealOcwi(value) {
    return typeof value === 'function' && !value.__ocwiLoaderProxy && !isStub(value);
  }

  // The async snippet's queue-stub is a plain function (not the loader's proxy) that
  // carries a .q array of buffered call arguments. It must not be mistaken for the
  // real core - that would short-circuit the load as already-loaded and drop the
  // buffered calls - nor for the proxy.
  function isStub(value) {
    return (
      typeof value === 'function' && !value.__ocwiLoaderProxy && Array.isArray(value.q)
    );
  }

  function noop() {}

  function readAttr(el, name) {
    if (!el || !el.getAttribute) return '';
    return String(el.getAttribute(name) || '').trim();
  }

  function readNonce(el) {
    if (!el) return '';
    return String(el.nonce || readAttr(el, 'nonce') || '').trim();
  }

  function normalizeVersion(value) {
    var version = String(value || '').trim();
    if (!version) return '';
    if (/^[A-Za-z0-9._~+-]+$/.test(version)) {
      // npm dist-tags are case-sensitive and canonically lowercase, so a mixed-case
      // tag like 'Latest' would build a 404 URL. An exact semver is left untouched:
      // published versions are case-sensitive and may carry pre-release identifiers.
      return isExactVersion(version) ? version : version.toLowerCase();
    }

    warn('Ignoring invalid OCWI core version override: ' + version);
    return '';
  }

  // Runtime-only helper: 'latest' is the one dist-tag whose baked SRI is dropped at
  // resolve time (see resolveCoreSri). The build guards mutability via isExactVersion.
  function isLatestVersion(version) {
    return String(version || '').toLowerCase() === 'latest';
  }

  // Mirror of isExactVersion() in scripts/build.mjs; keep the two in sync (the inlined IIFE loader cannot share a module with the build).
  function isExactVersion(version) {
    return /^\d+\.\d+\.\d+([-+].*)?$/.test(String(version || '').trim());
  }

  function appendCacheBuster(url) {
    return appendQueryParam(url, 'ocwi-loader-cache', getHourlyCacheBucket());
  }

  function getHourlyCacheBucket() {
    return String(Math.floor(new Date().getTime() / 3600000));
  }

  function appendQueryParam(url, name, value) {
    var hashIndex = url.indexOf('#');
    var hash = hashIndex === -1 ? '' : url.slice(hashIndex);
    var base = hashIndex === -1 ? url : url.slice(0, hashIndex);
    var separator = base.indexOf('?') === -1 ? '?' : '&';

    return base + separator + encodeURIComponent(name) + '=' + encodeURIComponent(value) + hash;
  }

  function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function stripSlashes(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
  }

  function escapeHtmlAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function warn(message) {
    if (root.console && typeof root.console.warn === 'function') {
      root.console.warn('[OCWI Loader] ' + message);
    }
  }
})();
