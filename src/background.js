/*
 * FlagSwap background service worker.
 *
 * Two jobs:
 *   1. (existing) Stable SW registration so the extension ID is discoverable.
 *   2. (new) The ONLY place LaunchDarkly REST API calls happen. The token lives
 *      in chrome.storage.local and is read here per-call; it is NEVER sent to a
 *      content script, the MAIN-world inject.js, or any message a page could
 *      observe. The popup talks to us via chrome.runtime.sendMessage and we
 *      return flag DATA only.
 *
 * Pure shaping logic comes from ldapi.js (importScripts attaches
 * self.__FlagSwapLdApi). All network + token handling is here.
 */

/* global importScripts */
// Chrome runs this as a service worker and pulls deps in via importScripts.
// Firefox runs it as an event-page background script with ldapi.js already
// listed before us in manifest background.scripts — where importScripts does
// not exist — so guard the call.
if (typeof importScripts === "function" && !self.__FlagSwapLdApi) {
  importScripts("ldapi.js");
}
var LdApi = self.__FlagSwapLdApi;

// ---- storage keys ---------------------------------------------------------
var KEY_TOKEN = "flagswap:ldToken";
var KEY_BASEURL = "flagswap:ldBaseUrl";

var DEFAULT_BASE = "https://app.launchdarkly.com";
// Allow-list of valid bases (so a bad stored value can't redirect the token).
var ALLOWED_BASES = {
  "https://app.launchdarkly.com": true,
  "https://app.eu.launchdarkly.com": true,
  "https://app.launchdarkly.us": true,
};

var LD_API_VERSION = "20240415";
var MAX_RETRIES = 4; // for 429 backoff
var MAX_PAGES = 100; // hard safety cap on pagination loops

// ---- lifecycle (existing) -------------------------------------------------
self.addEventListener("install", function () {
  if (self.skipWaiting) self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients ? self.clients.claim() : Promise.resolve());
});

// Set the action badge background color ONCE (it persists across tabs/sessions;
// per-tab we only ever toggle the badge TEXT). Wrapped defensively because the
// action API can be momentarily unavailable while the SW is spinning up.
(function setBadgeColorOnce() {
  try {
    if (chrome.action && chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    }
  } catch (e) {}
})();

// ---- small helpers --------------------------------------------------------
function getStorage(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (res) {
      resolve(res || {});
    });
  });
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

// Resolve the configured base URL, falling back safely.
function resolveBase(stored) {
  var b = stored && stored[KEY_BASEURL];
  if (typeof b === "string" && ALLOWED_BASES[b]) return b;
  return DEFAULT_BASE;
}

// Read the response's rate-limit headers into a plain object for computeBackoffMs.
function headersToObj(resp) {
  var o = {};
  try {
    resp.headers.forEach(function (v, k) {
      o[k] = v;
    });
  } catch (e) {}
  return o;
}

/*
 * SERIALIZED LD API request queue.
 *
 * We never fan out parallel requests (rate-limit friendliness + ordered
 * pagination). Every ldFetch() call chains onto the previous one.
 */
var apiChain = Promise.resolve();
function serialized(taskFn) {
  var run = apiChain.then(taskFn, taskFn);
  // keep the chain alive regardless of individual outcomes
  apiChain = run.then(
    function () {},
    function () {}
  );
  return run;
}

/*
 * One authenticated GET against the LD API, with 429 backoff. Returns the parsed
 * JSON body. `pathOrHref` may be a full path beginning with /api/v2 (pagination
 * "next" hrefs) or a path we build ourselves. We always prefix the base host.
 *
 * The token is read fresh from storage and attached ONLY to the outbound LD
 * request headers. It is never returned or logged.
 */
function ldGet(token, base, pathOrHref) {
  var url = base + pathOrHref;
  return (function attempt(n) {
    return fetch(url, {
      method: "GET",
      headers: {
        // RAW token, NO "Bearer" prefix (verified).
        Authorization: token,
        "LD-API-Version": LD_API_VERSION,
        "Content-Type": "application/json",
      },
    }).then(function (resp) {
      if (resp.status === 429 && n < MAX_RETRIES) {
        var waitMs = LdApi.computeBackoffMs(
          headersToObj(resp),
          n,
          Date.now(),
          Math.random()
        );
        return sleep(waitMs).then(function () {
          return attempt(n + 1);
        });
      }
      if (!resp.ok) {
        // Surface a structured error WITHOUT the token.
        return resp
          .text()
          .then(function (txt) {
            var msg = txt;
            try {
              var j = JSON.parse(txt);
              msg = j.message || j.code || txt;
            } catch (e) {}
            var err = new Error(msg || "HTTP " + resp.status);
            err.status = resp.status;
            throw err;
          });
      }
      return resp.json();
    });
  })(0);
}

// ---- message-handled operations ------------------------------------------

// ld:test -> GET /projects, return { ok, projectCount } | { ok:false,... }
function opTest() {
  return getStorage([KEY_TOKEN, KEY_BASEURL]).then(function (stored) {
    var token = stored[KEY_TOKEN];
    if (!token) {
      return { ok: false, status: 0, message: "No token saved." };
    }
    var base = resolveBase(stored);
    return serialized(function () {
      return ldGet(token, base, "/api/v2/projects");
    })
      .then(function (body) {
        var count = body && Array.isArray(body.items) ? body.items.length : 0;
        return { ok: true, projectCount: count };
      })
      .catch(function (err) {
        return {
          ok: false,
          status: err.status || 0,
          message: err.message || "Request failed",
        };
      });
  });
}

// ld:projects -> normalized projects (with client-side IDs)
function opProjects() {
  return getStorage([KEY_TOKEN, KEY_BASEURL]).then(function (stored) {
    var token = stored[KEY_TOKEN];
    if (!token) return { ok: false, message: "No token saved." };
    var base = resolveBase(stored);
    return serialized(function () {
      return ldGet(token, base, "/api/v2/projects?expand=environments");
    })
      .then(function (body) {
        var items = body && body.items ? body.items : [];
        return { ok: true, projects: LdApi.normalizeProjects(items) };
      })
      .catch(function (err) {
        return { ok: false, status: err.status || 0, message: err.message };
      });
  });
}

// ld:flags { projectKey, envKey } -> normalized flags (paginated)
function opFlags(req) {
  var projectKey = req && req.projectKey;
  var envKey = req && req.envKey;
  if (!projectKey || !envKey) {
    return Promise.resolve({ ok: false, message: "projectKey/envKey required." });
  }
  return getStorage([KEY_TOKEN, KEY_BASEURL]).then(function (stored) {
    var token = stored[KEY_TOKEN];
    if (!token) return { ok: false, message: "No token saved." };
    var base = resolveBase(stored);

    var firstPath =
      "/api/v2/flags/" +
      encodeURIComponent(projectKey) +
      "?env=" +
      encodeURIComponent(envKey) +
      "&summary=1";

    // Paginate by following _links.next.href, SERIALIZED (one at a time).
    return serialized(function () {
      var collected = [];
      var pages = 0;
      function fetchPage(pathOrHref) {
        return ldGet(token, base, pathOrHref).then(function (body) {
          pages++;
          if (body && Array.isArray(body.items)) {
            collected = collected.concat(body.items);
          }
          var next = LdApi.parseNextLink(body);
          if (next && pages < MAX_PAGES) {
            return fetchPage(next);
          }
          return collected;
        });
      }
      return fetchPage(firstPath);
    })
      .then(function (allItems) {
        return {
          ok: true,
          flags: LdApi.normalizeFlags(allItems, envKey),
        };
      })
      .catch(function (err) {
        return { ok: false, status: err.status || 0, message: err.message };
      });
  });
}

// ---- message router -------------------------------------------------------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string") return false;

  // Override-count badge update from banner.js (ISOLATED content script).
  // This is fully synchronous (no async sendResponse), so it must be handled
  // BEFORE the ld:* switch — and we return false so it never holds the channel
  // open or interferes with the ld:* `return true` async pattern. We use
  // sender.tab.id only, so the broad "tabs" permission is NOT required.
  // Open settings in a new tab — delegated here so the background (which
  // outlives the popup window) creates the tab reliably in both Chrome and Firefox.
  if (msg.type === "ui:openSettings") {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") });
    } catch (e) {}
    return false;
  }

  if (msg.type === "flagswap:count") {
    var tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === "number" && chrome.action && chrome.action.setBadgeText) {
      var n = typeof msg.count === "number" ? msg.count : 0;
      try {
        chrome.action.setBadgeText({
          tabId: tabId,
          text: n > 0 ? String(n) : "",
        });
      } catch (e) {}
    }
    return false; // nothing async; do not keep the channel open
  }

  var handler;
  switch (msg.type) {
    case "ld:test":
      handler = opTest();
      break;
    case "ld:projects":
      handler = opProjects();
      break;
    case "ld:flags":
      handler = opFlags(msg);
      break;
    default:
      return false; // not ours
  }

  handler
    .then(function (result) {
      sendResponse(result);
    })
    .catch(function (err) {
      // Defensive: never throw the token; only a message.
      sendResponse({ ok: false, message: (err && err.message) || "error" });
    });
  return true; // keep the message channel open for the async sendResponse
});
