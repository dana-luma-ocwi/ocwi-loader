/*! ocwi-loader v0.1.0
 * core: ocwi-core@latest
 * This file is generated from src/loader.js.
 */
(function () {
  'use strict';

  var LOADER_VERSION = "0.1.0";
  var DEFAULT_CORE_PACKAGE = "ocwi-core";
  var DEFAULT_CORE_VERSION = "latest";
  var DEFAULT_CORE_FILE = "dist/ocwi.min.js";
  var DEFAULT_CDN_BASE = "https://cdn.jsdelivr.net/npm";
  var GLOBAL_NAME = 'OCWI';
  var META_NAME = 'OCWI_LOADER';

  var root = typeof window !== 'undefined' ? window : globalThis;
  var doc = root.document;
  var currentScript = getCurrentScript();
  var corePackage = readAttr(currentScript, 'data-ocwi-package') || DEFAULT_CORE_PACKAGE;
  var coreVersion = normalizeVersion(readAttr(currentScript, 'data-ocwi-version')) || DEFAULT_CORE_VERSION;
  var coreUrl = resolveCoreUrl(currentScript, corePackage, coreVersion);
  var scriptNonce = readNonce(currentScript);
  var meta = (root[META_NAME] = root[META_NAME] || {});

  meta.loaderVersion = LOADER_VERSION;
  meta.corePackage = corePackage;
  meta.coreVersion = coreVersion;
  meta.coreUrl = coreUrl;
  meta.loaded = isRealOcwi(root[GLOBAL_NAME]);
  meta.mode = meta.loaded ? 'already-loaded' : 'pending';
  meta.startedAt = new Date().toISOString();

  if (meta.loaded) return;

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
        (scriptNonce ? ' nonce="' + escapeHtmlAttr(scriptNonce) + '"' : '') +
        '"><\/script>'
    );
    pollForLoaded();
    return;
  }

  meta.mode = 'dynamic';
  warn(
    'OCWI loader was not executed as a parser-blocking classic script. ' +
      'The core bundle will load asynchronously; synchronous inline calls should use ' +
      '<script src=".../loader.js"></script> without async, defer, or type="module".'
  );
  installDeferredProxy();
  injectDynamicScript(coreUrl);

  function resolveCoreUrl(script, packageName, version) {
    var explicitSrc = readAttr(script, 'data-ocwi-src');
    if (explicitSrc) return explicitSrc;

    var coreFile = stripSlashes(readAttr(script, 'data-ocwi-file') || DEFAULT_CORE_FILE);
    var cdnBase = stripTrailingSlash(readAttr(script, 'data-ocwi-cdn-base') || DEFAULT_CDN_BASE);
    var coreUrl = cdnBase + '/' + packageName + '@' + version + '/' + coreFile;

    return isLatestVersion(version) ? appendCacheBuster(coreUrl) : coreUrl;
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
    script.async = false;
    script.setAttribute('data-ocwi-core', 'true');
    script.setAttribute('data-ocwi-core-version', meta.coreVersion);
    if (scriptNonce) {
      script.setAttribute('nonce', scriptNonce);
      try {
        script.nonce = scriptNonce;
      } catch (_) {
        // Some browsers expose nonce as a protected reflected property.
      }
    }

    script.onload = function () {
      meta.loaded = isRealOcwi(root[GLOBAL_NAME]);
      meta.loadedAt = new Date().toISOString();
      root.__OCWI_LOADER_LOADING__ = false;
      replayDeferredQueue();
    };

    script.onerror = function () {
      var error = new Error('Failed to load OCWI core bundle: ' + src);
      meta.error = error.message;
      root.__OCWI_LOADER_LOADING__ = false;
      failDeferredProxy(error);
      warn(error.message);
    };

    var target = doc.head || doc.documentElement || doc.body;
    if (!target || !target.appendChild) {
      script.onerror();
      return;
    }

    target.appendChild(script);
  }

  function installDeferredProxy() {
    if (isRealOcwi(root[GLOBAL_NAME])) return;
    if (root[GLOBAL_NAME] && root[GLOBAL_NAME].__ocwiLoaderProxy) return;

    var queue = root.__OCWI_LOADER_QUEUE__ || [];
    root.__OCWI_LOADER_QUEUE__ = queue;

    var proxy = function () {
      var handle = createDeferredHandle();
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

  function replayDeferredQueue() {
    var queue = root.__OCWI_LOADER_QUEUE__;
    var realOcwi = root[GLOBAL_NAME];

    if (!queue || !queue.length) return;

    if (!isRealOcwi(realOcwi)) {
      failDeferredProxy(new Error('OCWI core loaded but window.OCWI was not registered.'));
      return;
    }

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

  function createDeferredHandle() {
    var target = null;
    var pending = [];
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
        if (rejectReady) rejectReady(error);
      }
    };

    function callOrQueue(method, argsLike) {
      if (target && typeof target[method] === 'function') {
        return target[method].apply(target, Array.prototype.slice.call(argsLike));
      }

      pending.push({
        method: method,
        args: Array.prototype.slice.call(argsLike)
      });

      return method === 'getState' ? null : publicHandle;
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

  function pollForLoaded() {
    if (!root.setTimeout) return;

    root.setTimeout(function () {
      meta.loaded = isRealOcwi(root[GLOBAL_NAME]);
      if (meta.loaded) {
        meta.loadedAt = new Date().toISOString();
        root.__OCWI_LOADER_LOADING__ = false;
      }
    }, 0);
  }

  function isRealOcwi(value) {
    return typeof value === 'function' && !value.__ocwiLoaderProxy;
  }

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
    if (/^[A-Za-z0-9._~+-]+$/.test(version)) return version;

    warn('Ignoring invalid OCWI core version override: ' + version);
    return '';
  }

  function isLatestVersion(version) {
    return String(version || '').toLowerCase() === 'latest';
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
