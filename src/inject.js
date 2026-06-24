/*
 * FlagSwap MAIN-world injection.
 *
 * Registered with "world":"MAIN", "run_at":"document_start" so it runs IN the
 * page's JS context BEFORE the LaunchDarkly SDK loads. It wraps window.fetch
 * (polling) and window.EventSource (streaming) so that any LD payload the SDK
 * receives has overrides already baked in.
 *
 * It CANNOT touch chrome.storage (MAIN world has no extension APIs). Overrides
 * arrive from the ISOLATED bridge.js via a CustomEvent on window. We also gate
 * every intercepted response behind an "overrides ready" promise so the SDK can
 * never initialize with un-overridden values (the storage-load race).
 *
 * All real logic lives in window.__FlagSwapCore (src/core.js). This file is glue.
 */
(function () {
  "use strict";

  var Core = window.__FlagSwapCore;
  if (!Core) {
    // core.js must be listed before inject.js in the manifest. Fail loud-ish.
    // eslint-disable-next-line no-console
    console.error("[FlagSwap] core.js not loaded before inject.js");
    return;
  }

  var TAG = "[FlagSwap:inject]";

  // ---- transport observability (Tier-2 spike) -----------------------------
  // Lets us see, at runtime on the page, WHICH transport LD actually used:
  //   ldEvalFetches         : LD poll/eval requests that went through our fetch wrap (INTERCEPTABLE)
  //   ldStreamEventSources  : LD streams proxied through our EventSource wrapper (INTERCEPTABLE)
  //   ldStreamFetches       : LD stream requests that arrived as fetch (polyfilled stream -> BYPASS)
  // Plus observation-only counters (we do NOT rewrite these — they reveal bypass):
  //   ldEvalXhrs            : LD poll/eval requests sent via XMLHttpRequest (BYPASS — we don't wrap XHR)
  //   ldStreamPings         : LD "ping" EventSource streams (no flag data; tells SDK to re-poll via XHR)
  // A stream showing up as ldStreamFetches (and not ldStreamEventSources) means
  // the SDK streamed via fetch/XHR, which an MV3 content script cannot rewrite.
  var stats = (window.__FLAGSWAP_STATS = window.__FLAGSWAP_STATS || {
    ldEvalFetches: 0,
    ldStreamEventSources: 0,
    ldStreamFetches: 0,
    ldEvalXhrs: 0,
    ldStreamPings: 0,
  });

  // ---- override state + readiness gate ------------------------------------
  var overrides = {};

  // The gate: nothing intercepted resolves until the bridge signals readiness
  // at least once. The bridge ALWAYS signals, even with zero overrides, so this
  // resolves promptly and the SDK is never blocked indefinitely.
  var resolveReady;
  var readyPromise = new Promise(function (res) {
    resolveReady = res;
  });
  var isReady = false;

  function markReady() {
    if (!isReady) {
      isReady = true;
      resolveReady();
    }
  }

  // The bridge dispatches CustomEvent('flagswap:overrides', { detail: {...} }).
  // We listen on window (bridge dispatches on both window & document to be safe).
  window.addEventListener("flagswap:overrides", function (ev) {
    // Wrap detail access: on Firefox a cross-compartment read could throw, and
    // we must ALWAYS markReady() afterward — otherwise the readiness gate never
    // releases and the EventSource wrapper stalls the LD stream until timeout.
    try {
      var detail = ev && ev.detail;
      if (detail && typeof detail.overrides === "object") {
        overrides = detail.overrides || {};
      }
    } catch (e) {
      // ignore; still release the gate below.
    }
    markReady();
  });

  // Safety net: if the bridge somehow never fires (e.g. extension disabled mid
  // navigation), don't hang the page's network forever. Release the gate after
  // a short timeout with whatever overrides we have (likely none).
  setTimeout(markReady, 3000);

  // ---- schema broadcast (for popup value controls) ------------------------
  // When we parse an LD eval response we can infer each flag's kind from its
  // value type. Firing this event lets bridge.js store discovered kinds so the
  // popup can show toggles / number inputs instead of raw text fields — even
  // without a LaunchDarkly API token configured.
  function extractAndBroadcastSchemas(flagsMap) {
    if (!flagsMap || typeof flagsMap !== "object") return;
    var schemas = {};
    var keys = Object.keys(flagsMap);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(flagsMap, k)) continue;
      var flag = flagsMap[k];
      if (!flag || typeof flag !== "object") continue;
      var val = flag.value;
      var kind;
      if (typeof val === "boolean") kind = "boolean";
      else if (typeof val === "string") kind = "string";
      else if (typeof val === "number") kind = "number";
      else if (val !== null && typeof val === "object") kind = "json";
      if (kind) schemas[k] = { kind: kind };
    }
    if (Object.keys(schemas).length) {
      try {
        window.dispatchEvent(new CustomEvent("flagswap:schemas", { detail: { schemas: schemas } }));
      } catch (e) {}
    }
  }

  // ---- fetch wrapper (polling) --------------------------------------------
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      // Observability: a LD stream arriving as a fetch means the SDK is using a
      // polyfilled fetch/XHR stream transport, which we CANNOT rewrite (MV3 can't
      // touch a streaming response body). Count it and pass it straight through.
      if (Core.isLDStreamUrl(url)) {
        stats.ldStreamFetches++;
        log("LD stream via fetch (NOT interceptable)", url);
        return origFetch(input, init);
      }
      if (!Core.isLDEvalUrl(url)) {
        return origFetch(input, init);
      }
      stats.ldEvalFetches++;
      // It's an LD eval/poll request. Fetch real, then rewrite the JSON body
      // AFTER overrides are ready.
      return Promise.all([origFetch(input, init), readyPromise]).then(function (
        results
      ) {
        var resp = results[0];
        // Only rewrite successful JSON responses.
        if (!resp || !resp.ok) return resp;
        return resp
          .clone()
          .json()
          .then(function (body) {
            extractAndBroadcastSchemas(body);
            var rewritten = Core.applyOverridesToMap(body, overrides);
            log("poll rewrite", url);
            var headers = new Headers(resp.headers);
            // Body was decoded by .json() and is re-serialized fresh, so the
            // original length/encoding headers no longer describe it.
            headers.delete("content-length");
            headers.delete("content-encoding");
            return new Response(JSON.stringify(rewritten), {
              status: resp.status,
              statusText: resp.statusText,
              headers: headers,
            });
          })
          .catch(function (e) {
            // If anything goes wrong parsing, return the original untouched.
            log("poll rewrite failed, passing through", e);
            return resp;
          });
      });
    };
    log("window.fetch wrapped");
  }

  // ---- XMLHttpRequest wrapper (polling — the PRIMARY transport) -----------
  // The LD browser SDK v3 sends its eval/poll over XMLHttpRequest, not fetch
  // (verified against the trial env: GET .../contexts/<ctx> and REPORT
  // .../context both arrive as XHR; useReport rides an XHR re-poll). So XHR is
  // where we MUST rewrite, not just observe.
  //
  // Design mirrors the EventSource wrapper:
  //   - We replace window.XMLHttpRequest with a proxy class wrapping a NATIVE
  //     XHR that does the real network/parsing.
  //   - For NON-LD-eval requests the proxy is a TRANSPARENT pass-through: every
  //     method/prop/event forwards straight to the native XHR, so we can never
  //     break unrelated XHR on the page (same safety principle as the non-LD
  //     EventSource bypass).
  //   - For LD eval URLs we compute a rewritten body once the request completes,
  //     gate it behind readyPromise (overrides must be loaded first), and only
  //     then surface DONE / load / responseText / response with the rewrite.
  //   - On any parse/rewrite failure we fall back to the untouched native
  //     response so the SDK is never broken.
  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    // Events we relay from the native XHR to the page. Progress events are
    // forwarded live; the terminal load/loadend/readystatechange(DONE) are
    // deferred for LD eval requests until the rewrite is ready.
    var XHR_EVENTS = [
      "loadstart",
      "progress",
      "abort",
      "error",
      "timeout",
      "load",
      "loadend",
      "readystatechange",
    ];

    function FlagSwapXHR() {
      this._xhr = new NativeXHR();
      this._isLDEval = false; // decided at open()
      this._method = null;
      this._url = null;
      // page-registered listeners + on<event> handlers we manage ourselves
      this._listeners = {}; // { type: [fn,...] }
      this._on = {}; // { type: fn }  (onload/onreadystatechange/onerror/...)
      // Rewrite state for LD eval requests.
      this._rewritten = null; // { text, json|undefined }
      this._rewriteReady = false;
      this._deferred = []; // queued terminal events awaiting readyPromise

      var self = this;
      // Bridge every native event into our dispatcher.
      XHR_EVENTS.forEach(function (type) {
        self._xhr.addEventListener(type, function (ev) {
          self._onNative(type, ev);
        });
      });
    }

    // ---- internal: native event handling --------------------------------
    FlagSwapXHR.prototype._onNative = function (type, ev) {
      var self = this;

      // Non-LD-eval: pure pass-through, dispatch immediately.
      if (!this._isLDEval) {
        this._emit(type, ev);
        return;
      }

      // LD-eval terminal signals (the response is fully available). We must
      // compute the rewrite AND wait for overrides before surfacing them.
      var isTerminalLoad = type === "load" || type === "loadend";
      var isDoneRS =
        type === "readystatechange" && this._xhr.readyState === 4;

      if (isTerminalLoad || isDoneRS) {
        // Compute the rewrite once, lazily, on the first terminal signal.
        if (!this._rewriteReady) {
          this._computeRewrite();
        }
        // Defer surfacing until overrides are loaded (storage-load race), same
        // gate as fetch/EventSource.
        readyPromise.then(function () {
          self._emit(type, ev);
        });
        return;
      }

      // Non-terminal LD-eval events (loadstart/progress/etc.): pass through.
      // readystatechange for states < 4 also passes through immediately so the
      // SDK sees normal progression; only the DONE transition is gated above.
      this._emit(type, ev);
    };

    // Build the rewritten body from the native response. On any failure leave
    // _rewritten null so getters fall back to the native values untouched.
    FlagSwapXHR.prototype._computeRewrite = function () {
      this._rewriteReady = true;
      try {
        var rt = this._xhr.responseType;
        var raw;
        if (rt === "" || rt === "text") {
          raw = this._xhr.responseText;
        } else if (rt === "json") {
          // response is already a parsed object; re-stringify to parse uniformly
          raw = JSON.stringify(this._xhr.response);
        } else {
          // arraybuffer/blob/document — not used by LD eval; don't touch.
          return;
        }
        var body = JSON.parse(raw);
        extractAndBroadcastSchemas(body);
        var rewrittenObj = Core.applyOverridesToMap(body, overrides);
        var text = JSON.stringify(rewrittenObj);
        this._rewritten = { text: text, json: rewrittenObj };
        log("XHR eval rewrite", this._url);
      } catch (e) {
        this._rewritten = null; // fall back to native response
        log("XHR eval rewrite failed, passing through", e);
      }
    };

    // Dispatch an event to on<type> handler + addEventListener listeners.
    FlagSwapXHR.prototype._emit = function (type, ev) {
      var on = this._on[type];
      if (typeof on === "function") {
        try {
          on.call(this, ev);
        } catch (e) {
          log("xhr on" + type + " threw", e);
        }
      }
      var list = this._listeners[type];
      if (list) {
        list.slice().forEach(function (fn) {
          try {
            fn.call(this, ev);
          } catch (e) {
            log("xhr listener threw", e);
          }
        }, this);
      }
    };

    // ---- public surface --------------------------------------------------
    FlagSwapXHR.prototype.open = function (method, url) {
      this._method = method;
      this._url = url;
      this._isLDEval = false;
      try {
        if (Core.isLDEvalUrl(url)) {
          this._isLDEval = true;
          stats.ldEvalXhrs++; // keep the regression counter working
          log("LD eval via XHR (will rewrite)", method, url);
        }
      } catch (e) {}
      return this._xhr.open.apply(this._xhr, arguments);
    };

    FlagSwapXHR.prototype.send = function () {
      return this._xhr.send.apply(this._xhr, arguments);
    };
    FlagSwapXHR.prototype.abort = function () {
      return this._xhr.abort.apply(this._xhr, arguments);
    };
    FlagSwapXHR.prototype.setRequestHeader = function () {
      return this._xhr.setRequestHeader.apply(this._xhr, arguments);
    };
    FlagSwapXHR.prototype.overrideMimeType = function () {
      return this._xhr.overrideMimeType.apply(this._xhr, arguments);
    };
    FlagSwapXHR.prototype.getAllResponseHeaders = function () {
      return this._xhr.getAllResponseHeaders.apply(this._xhr, arguments);
    };
    FlagSwapXHR.prototype.getResponseHeader = function () {
      return this._xhr.getResponseHeader.apply(this._xhr, arguments);
    };

    FlagSwapXHR.prototype.addEventListener = function (type, fn) {
      if (typeof fn !== "function") return;
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    };
    FlagSwapXHR.prototype.removeEventListener = function (type, fn) {
      var list = this._listeners[type];
      if (!list) return;
      this._listeners[type] = list.filter(function (f) {
        return f !== fn;
      });
    };
    FlagSwapXHR.prototype.dispatchEvent = function (ev) {
      return this._xhr.dispatchEvent(ev);
    };

    // responseText / response: serve the rewrite for LD eval once computed.
    Object.defineProperty(FlagSwapXHR.prototype, "responseText", {
      get: function () {
        if (this._isLDEval && this._rewritten) return this._rewritten.text;
        return this._xhr.responseText;
      },
      configurable: true,
    });
    Object.defineProperty(FlagSwapXHR.prototype, "response", {
      get: function () {
        if (this._isLDEval && this._rewritten) {
          // For responseType 'json', the SDK expects a PARSED object here; for
          // '' / 'text' it expects the string. Match native semantics.
          var rt = this._xhr.responseType;
          if (rt === "json") return this._rewritten.json;
          return this._rewritten.text;
        }
        return this._xhr.response;
      },
      configurable: true,
    });

    // Plain forwarding getters/setters for the rest of the XHR surface.
    function forwardGet(prop) {
      Object.defineProperty(FlagSwapXHR.prototype, prop, {
        get: function () {
          return this._xhr[prop];
        },
        configurable: true,
      });
    }
    function forwardGetSet(prop) {
      Object.defineProperty(FlagSwapXHR.prototype, prop, {
        get: function () {
          return this._xhr[prop];
        },
        set: function (v) {
          this._xhr[prop] = v;
        },
        configurable: true,
      });
    }
    ["status", "statusText", "readyState", "responseURL", "upload"].forEach(
      forwardGet
    );
    ["responseType", "timeout", "withCredentials"].forEach(forwardGetSet);

    // on<event> handler properties.
    ["load", "loadstart", "loadend", "progress", "abort", "error", "timeout", "readystatechange"].forEach(
      function (type) {
        Object.defineProperty(FlagSwapXHR.prototype, "on" + type, {
          get: function () {
            return this._on[type];
          },
          set: function (fn) {
            this._on[type] = fn;
          },
          configurable: true,
        });
      }
    );

    // Mirror readyState constants.
    ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"].forEach(function (
      c
    ) {
      FlagSwapXHR[c] = NativeXHR[c];
      FlagSwapXHR.prototype[c] = NativeXHR[c];
    });

    window.XMLHttpRequest = FlagSwapXHR;
    log("window.XMLHttpRequest wrapped");
  }

  // ---- EventSource wrapper (streaming) ------------------------------------
  // We cannot edit the raw SSE byte stream, so we replace window.EventSource
  // with a subclass-like wrapper. We let a REAL native EventSource do the
  // network/parsing, then re-dispatch each event to the page's listeners with
  // REWRITTEN data. We intercept both addEventListener('put'|'patch'|...) and
  // the on<event> handler properties, and we handle named SSE events as well as
  // the default 'message' event.
  var NativeES = window.EventSource;
  if (NativeES) {
    // Event types whose data we know how to rewrite. 'message' is included
    // because some setups deliver LD data on the default event.
    var REWRITE_TYPES = { put: true, patch: true, message: true };

    function rewriteEventData(type, rawData) {
      // Returns a (possibly) rewritten data string. On any failure, returns the
      // original so we never break the SDK's own parsing.
      try {
        var parsed = JSON.parse(rawData);
        var result;
        if (type === "patch") {
          result = Core.applyOverrideToPatch(parsed, overrides);
        } else if (type === "delete") {
          // delete is pass-through; an override-protected flag keeps its high
          // version, so a normal-version delete is ignored by the SDK anyway.
          return rawData;
        } else {
          // put / message -> full flags map
          result = Core.applyOverridesToMap(parsed, overrides);
        }
        return JSON.stringify(result);
      } catch (e) {
        log("event rewrite failed (" + type + "), passing through", e);
        return rawData;
      }
    }

    // Build a synthetic MessageEvent carrying rewritten data, preserving the
    // event type, lastEventId, and origin where possible.
    function makeSyntheticEvent(type, originalEvent, newData) {
      try {
        return new MessageEvent(type, {
          data: newData,
          lastEventId: originalEvent.lastEventId || "",
          origin: originalEvent.origin || "",
        });
      } catch (e) {
        // Fallback: shallow object good enough for handlers reading .data/.type.
        return { type: type, data: newData, lastEventId: originalEvent.lastEventId };
      }
    }

    function FlagSwapEventSource(url, config) {
      var urlStr = String(url);
      // Observation: LD "ping" streaming mode opens an EventSource to
      // clientstream.../ping/<env> that carries NO flag data — it only nudges
      // the SDK to RE-POLL (over XHR/REPORT). useReport:true uses ping mode, so
      // the real flag payload never crosses an EventSource. Count it; it is not
      // rewriteable here (nothing to rewrite on the wire), then fall through to
      // the native bypass below.
      if (/clientstream\.launchdarkly\.com\/ping/.test(urlStr) ||
          /stream\.launchdarkly\.com\/ping/.test(urlStr)) {
        stats.ldStreamPings++;
        log("LD ping stream (no flag data; SDK will re-poll via XHR)", urlStr);
      }
      // Only proxy LaunchDarkly eval streams. For every other URL (incl. ping),
      // hand back a real native EventSource so our partial reimplementation can
      // never break unrelated SSE (constructors may return a different object).
      if (!Core.isLDStreamUrl(urlStr)) {
        return new NativeES(url, config);
      }
      // LD branch: this stream is flowing through our wrapper, so we CAN
      // intercept it. Count it (observability for the useReport spike).
      stats.ldStreamEventSources++;
      var self = this;
      this._url = String(url);
      this._isLD = Core.isLDStreamUrl(this._url);
      this._es = new NativeES(url, config);

      // Per-event-type user listeners we manage ourselves (so we can wrap).
      this._listeners = {}; // { type: [fn, ...] }
      this._onhandlers = {}; // { type: fn }  (onmessage/onput/onpatch/...)

      // Mirror readonly props.
      ["url", "readyState", "withCredentials"].forEach(function (p) {
        Object.defineProperty(self, p, {
          get: function () {
            return self._es[p];
          },
          configurable: true,
        });
      });

      // open/error just forward.
      this._es.onopen = function (e) {
        if (typeof self.onopen === "function") self.onopen(e);
      };
      this._es.onerror = function (e) {
        if (typeof self.onerror === "function") self.onerror(e);
      };
    }

    // Central dispatcher: when the native ES fires `type`, gate on readiness,
    // rewrite if it's an LD stream + known type, then invoke user handlers.
    FlagSwapEventSource.prototype._handle = function (type, nativeEvent) {
      var self = this;
      readyPromise.then(function () {
        var data = nativeEvent && nativeEvent.data;
        var outData = data;
        if (self._isLD && REWRITE_TYPES[type] && typeof data === "string") {
          outData = rewriteEventData(type, data);
        }
        var ev =
          outData === data
            ? nativeEvent
            : makeSyntheticEvent(type, nativeEvent, outData);

        // on<event> property handler
        var on = self._onhandlers[type];
        if (typeof on === "function") on.call(self, ev);
        // also support .onmessage for the default message event
        if (type === "message" && typeof self.onmessage === "function") {
          self.onmessage.call(self, ev);
        }
        // addEventListener listeners
        var list = self._listeners[type];
        if (list) {
          list.slice().forEach(function (fn) {
            try {
              fn.call(self, ev);
            } catch (err) {
              log("listener threw", err);
            }
          });
        }
      });
    };

    // Ensure the native ES is actually subscribed to `type` exactly once.
    FlagSwapEventSource.prototype._ensureNative = function (type) {
      var self = this;
      if (this._nativeBound && this._nativeBound[type]) return;
      if (!this._nativeBound) this._nativeBound = {};
      this._nativeBound[type] = true;
      this._es.addEventListener(type, function (e) {
        self._handle(type, e);
      });
    };

    FlagSwapEventSource.prototype.addEventListener = function (type, fn) {
      if (typeof fn !== "function") return;
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
      this._ensureNative(type);
    };

    FlagSwapEventSource.prototype.removeEventListener = function (type, fn) {
      var list = this._listeners[type];
      if (!list) return;
      this._listeners[type] = list.filter(function (f) {
        return f !== fn;
      });
    };

    FlagSwapEventSource.prototype.close = function () {
      return this._es.close();
    };

    FlagSwapEventSource.prototype.dispatchEvent = function (e) {
      return this._es.dispatchEvent(e);
    };

    // Define on<event> handler properties. LD's SDK typically uses
    // addEventListener, but some code uses es.onmessage / es.onput. We trap the
    // common ones plus a generic onmessage.
    ["message", "put", "patch", "delete"].forEach(function (type) {
      Object.defineProperty(FlagSwapEventSource.prototype, "on" + type, {
        get: function () {
          return this._onhandlers[type];
        },
        set: function (fn) {
          this._onhandlers[type] = fn;
          if (typeof fn === "function") this._ensureNative(type);
        },
        configurable: true,
      });
    });

    // Mirror EventSource constants.
    FlagSwapEventSource.CONNECTING = NativeES.CONNECTING;
    FlagSwapEventSource.OPEN = NativeES.OPEN;
    FlagSwapEventSource.CLOSED = NativeES.CLOSED;
    FlagSwapEventSource.prototype.CONNECTING = NativeES.CONNECTING;
    FlagSwapEventSource.prototype.OPEN = NativeES.OPEN;
    FlagSwapEventSource.prototype.CLOSED = NativeES.CLOSED;

    window.EventSource = FlagSwapEventSource;
    log("window.EventSource wrapped");
  }

  function log() {
    if (window.__FLAGSWAP_DEBUG) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(TAG);
      // eslint-disable-next-line no-console
      console.log.apply(console, args);
    }
  }

  // Announce presence (handy for the demo page / debugging).
  window.__FLAGSWAP_INJECTED = true;
})();
