/*
 * FlagSwap popup UI (Phase 2a).
 *
 * Manages the RICH state schema (window.__FlagSwapState):
 *   flagswap:state = {
 *     version: 1,
 *     globalOverrides: { [flagKey]: { value, variation?, enabled:true } },
 *     groups:  [ { id, name, enabled, flags: { [k]: { value, variation? } } } ],
 *     domains: [ { id, name, pattern, matchType, enabled, groupIds:[], overrides:{...} } ],
 *   }
 *
 * The popup READS via __FlagSwapState.migrate(storageBag) (so a legacy
 * flagswap:overrides bag is auto-wrapped) and WRITES only flagswap:state. It no
 * longer writes the legacy flagswap:overrides key — the bridge migrates legacy
 * data on read, and the e2e seeds the legacy key directly (still works).
 *
 * Flag sources (for pickers + value controls) are unchanged from Phase 1:
 *   1. LaunchDarkly sync (token + project/env) via the service worker.
 *   2. Demo fallback (no token).
 * Security: the token is never read into page context beyond the settings form;
 * all LD calls go through chrome.runtime.sendMessage to the SW.
 */
(function () {
  "use strict";

  var State = window.__FlagSwapState;

  // ---- storage keys -------------------------------------------------------
  var K_STATE = "flagswap:state";
  var K_TOKEN = "flagswap:ldToken";
  var K_BASEURL = "flagswap:ldBaseUrl";
  var K_SEL = "flagswap:ldSelection";
  function cacheKey(proj, env) {
    return "flagswap:flagCache:" + proj + ":" + env;
  }

  // No pre-populated flags. Until a LaunchDarkly token is connected (which syncs
  // the real flag list), the Flags tab shows only flags the user adds manually
  // or has an override for.
  var DEMO_FLAGS = [];

  // ---- in-memory state ----------------------------------------------------
  var rich = { version: 1, globalOverrides: {}, groups: [], domains: [] };
  var projects = [];
  var selection = {};
  var flags = null; // normalized flag list (LD or null -> demo)
  var flagFilter = "";

  // ---- DOM refs -----------------------------------------------------------
  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    sourceNote: $("source-note"),
    // settings
    token: $("ld-token"),
    base: $("ld-base"),
    save: $("ld-save"),
    test: $("ld-test"),
    forget: $("ld-forget"),
    ldStatus: $("ld-status"),
    sync: $("sync"),
    project: $("ld-project"),
    env: $("ld-env"),
    csid: $("ld-csid"),
    syncBtn: $("ld-sync"),
    refresh: $("ld-refresh"),
    syncStatus: $("sync-status"),
    // tabs
    tabFlags: $("tab-flags"),
    countFlags: $("count-flags"),
    countGroups: $("count-groups"),
    countDomains: $("count-domains"),
    // flags
    flagSearch: $("flag-search"),
    overrideSummary: $("override-summary"),
    flags: $("flags"),
    // manual add-flag
    manualKey: $("manual-key"),
    manualType: $("manual-type"),
    manualValueHost: $("manual-value-host"),
    manualAddBtn: $("manual-add-btn"),
    manualStatus: $("manual-status"),
    // backup (export/import)
    exportBtn: $("export-btn"),
    importBtn: $("import-btn"),
    importFile: $("import-file"),
    backupStatus: $("backup-status"),
    // groups
    groupName: $("group-name"),
    groupAdd: $("group-add"),
    groups: $("groups"),
    // domains
    domainPattern: $("domain-pattern"),
    domainMatchType: $("domain-matchtype"),
    domainAdd: $("domain-add"),
    domains: $("domains"),
    // footer
    clear: $("clear"),
    cacheInfo: $("cache-info"),
  };

  // ---- storage helpers ----------------------------------------------------
  function get(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) {
        resolve(res || {});
      });
    });
  }
  function set(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, resolve);
    });
  }
  function remove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(keys, resolve);
    });
  }
  // Persist the rich state. This is the ONLY write of override data now.
  function saveState() {
    var o = {};
    o[K_STATE] = rich;
    return set(o);
  }
  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    // fallback (older environments)
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  // ---- service-worker messaging ------------------------------------------
  function sendSW(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, message: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, message: "no response" });
        }
      });
    });
  }
  function setStatus(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  // ---- flag metadata helpers ---------------------------------------------
  function activeFlags() {
    return flags || DEMO_FLAGS;
  }
  function flagByKey(key) {
    return activeFlags().find(function (f) {
      return f.key === key;
    });
  }
  function isMultivariate(flag) {
    return !!(flag && flag.kind === "multivariate" && flag.variations && flag.variations.length);
  }
  function defaultValueFor(flag) {
    if (!flag) return false;
    if (flag.kind === "boolean") return false;
    return isMultivariate(flag) ? flag.variations[0].value : "";
  }
  // Boolean: variation 0 = true, 1 = false (LD convention).
  function boolVariation(v) {
    return v ? 0 : 1;
  }
  function valueLabel(flag, value) {
    if (isMultivariate(flag)) {
      var v = flag.variations.find(function (x) {
        return JSON.stringify(x.value) === JSON.stringify(value);
      });
      if (v && v.name) return v.name + " — " + display(v.value);
    }
    return display(value);
  }
  function display(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  // ---- value-control factory ---------------------------------------------
  // Builds a control reflecting `entry` ({value, variation?}) for `flag`, and
  // calls onChange({value, variation?}) when edited. `disabled` greys it out.
  function buildValueControl(flag, entry, disabled, onChange) {
    if (isMultivariate(flag)) {
      var sel = document.createElement("select");
      sel.disabled = disabled;
      flag.variations.forEach(function (v, idx) {
        var opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = (v.name ? v.name + " — " : "") + display(v.value);
        sel.appendChild(opt);
      });
      var curIdx = flag.variations.findIndex(function (v) {
        return JSON.stringify(v.value) === JSON.stringify(entry.value);
      });
      sel.value = String(curIdx >= 0 ? curIdx : 0);
      sel.addEventListener("change", function () {
        var idx = parseInt(sel.value, 10);
        onChange({ value: flag.variations[idx].value, variation: idx });
      });
      return sel;
    }
    if (flag && flag.kind === "boolean") {
      var wrap = document.createElement("span");
      wrap.className = "val";
      var b = document.createElement("input");
      b.type = "checkbox";
      b.checked = entry.value === true;
      b.disabled = disabled;
      var bt = document.createElement("span");
      bt.textContent = b.checked ? "true" : "false";
      b.addEventListener("change", function () {
        onChange({ value: b.checked, variation: boolVariation(b.checked) });
      });
      wrap.appendChild(b);
      wrap.appendChild(bt);
      return wrap;
    }
    // unknown kind -> free text
    var t = document.createElement("input");
    t.type = "text";
    t.value = entry.value == null ? "" : String(entry.value);
    t.disabled = disabled;
    t.addEventListener("change", function () {
      onChange({ value: t.value });
    });
    return t;
  }

  // ---- settings (token / sync) -------------------------------------------
  function saveSettings() {
    var token = els.token.value.trim();
    var base = els.base.value;
    var writes = {};
    writes[K_BASEURL] = base;
    if (token) writes[K_TOKEN] = token;
    return set(writes).then(function () {
      if (token) els.token.value = "";
      setStatus(els.ldStatus, "Saved.", "ok");
    });
  }
  function testConnection() {
    setStatus(els.ldStatus, "Testing…", null);
    return saveSettings()
      .then(function () {
        return sendSW({ type: "ld:test" });
      })
      .then(function (res) {
        if (res.ok) {
          setStatus(els.ldStatus, "Connected. " + res.projectCount + " project(s) visible.", "ok");
          return loadProjects();
        }
        setStatus(
          els.ldStatus,
          "Failed" + (res.status ? " (HTTP " + res.status + ")" : "") + ": " + (res.message || "unknown error"),
          "err"
        );
      });
  }
  function forgetToken() {
    return remove([K_TOKEN]).then(function () {
      els.token.value = "";
      setStatus(els.ldStatus, "Token removed.", null);
      els.sync.style.display = "none";
      flags = null;
      updateSourceNote();
      renderAll();
    });
  }
  function loadProjects() {
    return sendSW({ type: "ld:projects" }).then(function (res) {
      if (!res.ok) {
        setStatus(els.syncStatus, "Could not load projects: " + res.message, "err");
        return;
      }
      projects = res.projects || [];
      els.sync.style.display = projects.length ? "block" : "none";
      populateProjectDropdown();
    });
  }
  function populateProjectDropdown() {
    els.project.innerHTML = "";
    projects.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = p.name || p.key;
      els.project.appendChild(opt);
    });
    if (selection.projectKey && projects.some(function (p) { return p.key === selection.projectKey; })) {
      els.project.value = selection.projectKey;
    }
    populateEnvDropdown();
  }
  function currentProject() {
    return projects.find(function (p) {
      return p.key === els.project.value;
    });
  }
  function populateEnvDropdown() {
    els.env.innerHTML = "";
    var p = currentProject();
    var envs = (p && p.environments) || [];
    envs.forEach(function (e) {
      var opt = document.createElement("option");
      opt.value = e.key;
      opt.textContent = e.name || e.key;
      opt.dataset.csid = e.clientSideId || "";
      els.env.appendChild(opt);
    });
    if (selection.envKey && envs.some(function (e) { return e.key === selection.envKey; })) {
      els.env.value = selection.envKey;
    }
    updateClientSideId();
  }
  function updateClientSideId() {
    var opt = els.env.options[els.env.selectedIndex];
    els.csid.textContent = (opt && opt.dataset.csid) || "—";
  }
  function persistSelection() {
    var opt = els.env.options[els.env.selectedIndex];
    selection = {
      projectKey: els.project.value,
      envKey: els.env.value,
      clientSideId: opt ? opt.dataset.csid : "",
    };
    var o = {};
    o[K_SEL] = selection;
    return set(o);
  }
  function syncFlags(force) {
    var proj = els.project.value;
    var env = els.env.value;
    if (!proj || !env) return Promise.resolve();
    persistSelection();
    var ck = cacheKey(proj, env);
    var doFetch = function () {
      setStatus(els.syncStatus, "Syncing flags…", null);
      return sendSW({ type: "ld:flags", projectKey: proj, envKey: env }).then(function (res) {
        if (!res.ok) {
          setStatus(els.syncStatus, "Sync failed: " + res.message, "err");
          return;
        }
        flags = res.flags || [];
        var cacheObj = {};
        cacheObj[ck] = { flags: flags, ts: Date.now() };
        return set(cacheObj).then(function () {
          setStatus(els.syncStatus, "Synced " + flags.length + " flag(s).", "ok");
          updateSourceNote();
          renderAll();
        });
      });
    };
    if (force) return doFetch();
    return get(ck).then(function (res) {
      var cached = res[ck];
      if (cached && Array.isArray(cached.flags)) {
        flags = cached.flags;
        setStatus(els.syncStatus, "Loaded " + flags.length + " cached flag(s) (" + timeAgo(cached.ts) + "). Refresh to update.", null);
        updateSourceNote();
        renderAll();
        return;
      }
      return doFetch();
    });
  }
  function timeAgo(ts) {
    if (!ts) return "unknown";
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }
  function updateSourceNote() {
    if (flags) {
      var p = selection.projectKey || els.project.value;
      var e = selection.envKey || els.env.value;
      els.sourceNote.textContent = "Synced flags from " + p + " / " + e + ".";
    } else {
      els.sourceNote.textContent = "No flags synced — add a flag manually below, or connect a LaunchDarkly token to sync the real list.";
    }
  }
  function loadCachedSelection() {
    if (!selection.projectKey || !selection.envKey) return Promise.resolve(false);
    var ck = cacheKey(selection.projectKey, selection.envKey);
    return get(ck).then(function (res) {
      var cached = res[ck];
      if (cached && Array.isArray(cached.flags)) {
        flags = cached.flags;
        updateSourceNote();
        renderAll();
        setStatus(els.syncStatus, "Loaded " + flags.length + " cached flag(s) (" + timeAgo(cached.ts) + "). Refresh to update.", null);
        return true;
      }
      return false;
    });
  }

  // =========================================================================
  // FLAGS TAB — individual global overrides (state.globalOverrides)
  // =========================================================================
  // Build the displayed flag list: the UNION of the synced/demo flags and any
  // keys present in globalOverrides that are NOT in that list (manual entries).
  // Manual entries are synthetic flag objects flagged with manual:true so they
  // survive a token sync replacing `flags`.
  function displayedFlags() {
    var base = activeFlags();
    var seen = {};
    var out = [];
    base.forEach(function (f) {
      seen[f.key] = true;
      out.push(f);
    });
    Object.keys(rich.globalOverrides).forEach(function (key) {
      if (seen[key]) return;
      seen[key] = true;
      out.push({ key: key, manual: true, clientSideAvailable: true });
    });
    return out;
  }

  function renderFlags() {
    els.flags.innerHTML = "";
    var list = displayedFlags();
    var q = flagFilter.trim().toLowerCase();
    var shown = list.filter(function (f) {
      if (!q) return true;
      return (
        (f.key && f.key.toLowerCase().indexOf(q) >= 0) ||
        (f.name && f.name.toLowerCase().indexOf(q) >= 0)
      );
    });

    if (!shown.length) {
      var e = document.createElement("p");
      e.className = "empty";
      e.textContent = q ? "No flags match “" + flagFilter + "”." : "No flags.";
      els.flags.appendChild(e);
      return;
    }

    shown.forEach(function (flag) {
      var serverSide = flag.clientSideAvailable === false;
      var ov = rich.globalOverrides[flag.key];
      var active = !!ov && ov.enabled === true && !serverSide;
      var entry = ov || { value: defaultValueFor(flag) };

      var card = document.createElement("div");
      card.className = "flag" + (active ? " on" : "") + (serverSide ? " disabled" : "");

      var row = document.createElement("div");
      row.className = "row";

      var enable = document.createElement("input");
      enable.type = "checkbox";
      enable.checked = active;
      enable.disabled = serverSide;
      enable.title = serverSide ? "Server-side only" : "Enable override";
      enable.addEventListener("change", function () {
        if (enable.checked) {
          // create/activate entry with current (or default) value
          var cur = rich.globalOverrides[flag.key] || { value: defaultValueFor(flag) };
          var newEntry = { value: cur.value, enabled: true };
          if (typeof cur.variation === "number") newEntry.variation = cur.variation;
          else if (flag.kind === "boolean") newEntry.variation = boolVariation(cur.value === true);
          rich.globalOverrides[flag.key] = newEntry;
        } else {
          // unchecking removes the entry entirely
          delete rich.globalOverrides[flag.key];
        }
        saveState().then(renderAll);
      });

      var key = document.createElement("div");
      key.className = "key";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = flag.name || flag.key;
      key.appendChild(name);
      if (flag.name && flag.name !== flag.key) {
        var mono = document.createElement("span");
        mono.className = "mono";
        mono.textContent = flag.key;
        key.appendChild(mono);
      }

      var badge = document.createElement("span");
      badge.className = "badge" + (active ? " active" : "");
      badge.textContent = flag.manual
        ? active
          ? "manual · on"
          : "manual"
        : active
        ? "override on"
        : flag.kind === "multivariate"
        ? "multi"
        : "bool";

      row.appendChild(enable);
      row.appendChild(key);
      row.appendChild(badge);
      // Manual entries get an explicit Remove button (they have no source list
      // to fall back to, so deleting the override removes the row entirely).
      if (flag.manual) {
        var rm = document.createElement("button");
        rm.className = "danger small";
        rm.textContent = "Remove";
        rm.title = "Delete this manual override";
        rm.addEventListener("click", function () {
          delete rich.globalOverrides[flag.key];
          saveState().then(renderAll);
        });
        row.appendChild(rm);
      }
      card.appendChild(row);

      if (serverSide) {
        var ss = document.createElement("div");
        ss.className = "ssonly";
        ss.textContent = "server-side only — can't override";
        card.appendChild(ss);
        els.flags.appendChild(card);
        return;
      }

      var valRow = document.createElement("div");
      valRow.className = "val" + (active ? "" : " muted");
      var valLabel = document.createElement("label");
      valLabel.textContent = "value:";
      valRow.appendChild(valLabel);
      var ctrl = flag.manual
        ? buildManualValueControl(flag.key, entry, !active)
        : buildValueControl(flag, entry, !active, function (patch) {
            var e2 = rich.globalOverrides[flag.key] || { enabled: true };
            e2.value = patch.value;
            if (typeof patch.variation === "number") e2.variation = patch.variation;
            e2.enabled = true;
            rich.globalOverrides[flag.key] = e2;
            saveState().then(renderAll);
          });
      valRow.appendChild(ctrl);
      card.appendChild(valRow);

      els.flags.appendChild(card);
    });
  }

  // Value editor for a MANUAL override (arbitrary key, no kind/variation info).
  // Shows the value as JSON-ish text; on edit, re-parses to preserve type
  // (true/false/numbers/objects round-trip; anything else stays a string).
  function buildManualValueControl(key, entry, disabled) {
    var t = document.createElement("input");
    t.type = "text";
    t.disabled = disabled;
    t.value = manualValueToText(entry.value);
    t.title = "JSON value (true, 42, \"text\", {…}); plain text accepted too";
    t.addEventListener("change", function () {
      var e = rich.globalOverrides[key] || { enabled: true };
      e.value = parseLooseValue(t.value);
      e.enabled = true;
      // manual entries never carry variation
      delete e.variation;
      rich.globalOverrides[key] = e;
      saveState().then(renderAll);
    });
    return t;
  }
  // Render a stored manual value for editing: strings shown raw, everything else
  // JSON-serialized so it round-trips through parseLooseValue.
  function manualValueToText(v) {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }
  // Parse a manual text value: try JSON first (true/false/number/object/array/
  // quoted string), fall back to the raw string.
  function parseLooseValue(text) {
    var s = text == null ? "" : String(text);
    try {
      return JSON.parse(s);
    } catch (e) {
      return s;
    }
  }

  function renderOverrideSummary() {
    var keys = Object.keys(rich.globalOverrides).filter(function (k) {
      return rich.globalOverrides[k] && rich.globalOverrides[k].enabled === true;
    });
    var n = keys.length;
    els.overrideSummary.textContent =
      n === 0 ? "No active individual overrides." : n + " active individual override" + (n === 1 ? "" : "s") + ".";
    els.countFlags.textContent = String(n);
  }

  // =========================================================================
  // MANUAL ADD-FLAG — override an arbitrary key not in sync/demo
  // =========================================================================
  // Render the type-appropriate value control into #manual-value-host.
  function renderManualValueControl() {
    var host = els.manualValueHost;
    host.innerHTML = "";
    var type = els.manualType.value;
    if (type === "boolean") {
      var wrap = document.createElement("span");
      wrap.className = "val";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = "manual-value";
      var lbl = document.createElement("span");
      lbl.textContent = cb.checked ? "true" : "false";
      cb.addEventListener("change", function () {
        lbl.textContent = cb.checked ? "true" : "false";
      });
      wrap.appendChild(cb);
      wrap.appendChild(lbl);
      host.appendChild(wrap);
    } else if (type === "json") {
      var ta = document.createElement("textarea");
      ta.id = "manual-value";
      ta.rows = 3;
      ta.placeholder = '{ "key": "value" }';
      ta.style.width = "100%";
      ta.style.font = "inherit";
      host.appendChild(ta);
    } else {
      // string | number
      var t = document.createElement("input");
      t.type = "text";
      t.id = "manual-value";
      t.placeholder = type === "number" ? "42" : "some text";
      host.appendChild(t);
    }
  }

  // Read + parse the manual value per the selected type. Returns
  // { ok:true, value } or { ok:false, error }.
  function readManualValue() {
    var type = els.manualType.value;
    var el = document.getElementById("manual-value");
    if (type === "boolean") {
      return { ok: true, value: !!(el && el.checked) };
    }
    var raw = el ? el.value : "";
    if (type === "number") {
      var n = Number(raw);
      if (raw.trim() === "" || isNaN(n)) {
        return { ok: false, error: "Not a valid number." };
      }
      return { ok: true, value: n };
    }
    if (type === "json") {
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch (e) {
        return { ok: false, error: "Invalid JSON: " + e.message };
      }
    }
    // string
    return { ok: true, value: raw };
  }

  function addManualFlag() {
    var key = (els.manualKey.value || "").trim();
    if (!key) {
      setStatus(els.manualStatus, "Flag key is required.", "err");
      els.manualKey.focus();
      return;
    }
    var parsed = readManualValue();
    if (!parsed.ok) {
      setStatus(els.manualStatus, parsed.error, "err");
      return;
    }
    // Manual entries: no variation (we don't know the LD variation index).
    rich.globalOverrides[key] = { value: parsed.value, enabled: true };
    saveState().then(function () {
      setStatus(els.manualStatus, "Added “" + key + "”.", "ok");
      // clear inputs on success
      els.manualKey.value = "";
      renderManualValueControl();
      renderAll();
    });
  }

  // =========================================================================
  // BACKUP — export / import config as human-readable JSON
  // =========================================================================
  var EXPORT_FORMAT = "flagswap-config";

  // PURE: build the export object. Includes ONLY the rich state — never the
  // token or any other storage key. (The token lives under flagswap:ldToken and
  // is never read into `rich`, so it cannot leak here.)
  function buildExportObject(state) {
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      state: {
        version: 1,
        globalOverrides: (state && state.globalOverrides) || {},
        groups: (state && state.groups) || [],
        domains: (state && state.domains) || [],
      },
    };
  }
  // PURE: serialize to the pretty JSON string we download.
  function serializeExport(state) {
    return JSON.stringify(buildExportObject(state), null, 2);
  }
  // PURE: pull the state out of an import payload — accept either the wrapped
  // {format,version,state} envelope or a bare state object. Returns the raw
  // candidate state (caller runs it through migrate() for safety).
  function extractImportedState(parsed) {
    if (parsed && typeof parsed === "object" && parsed.state && typeof parsed.state === "object") {
      return parsed.state;
    }
    return parsed; // bare state fallback
  }
  function dateStamp() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function exportConfig() {
    try {
      var text = serializeExport(rich);
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "flagswap-config-" + dateStamp() + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so the download has started.
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 0);
      setStatus(els.backupStatus, "Exported config.", "ok");
    } catch (e) {
      setStatus(els.backupStatus, "Export failed: " + e.message, "err");
    }
  }

  function importConfigFromText(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setStatus(els.backupStatus, "Import failed: invalid JSON.", "err");
      return;
    }
    var candidate = extractImportedState(parsed);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      setStatus(els.backupStatus, "Import failed: unrecognized file shape.", "err");
      return;
    }
    // Run through migrate() defensively so malformed input can't corrupt storage.
    var safe = State
      ? State.migrate({ "flagswap:state": candidate })
      : {
          version: 1,
          globalOverrides: candidate.globalOverrides || {},
          groups: candidate.groups || [],
          domains: candidate.domains || [],
        };
    if (!confirm("Replace your current FlagSwap config with the imported file?")) {
      setStatus(els.backupStatus, "Import cancelled.", null);
      return;
    }
    rich = safe;
    // Importing must NOT touch the saved token — we only write flagswap:state.
    saveState().then(function () {
      setStatus(els.backupStatus, "Imported config.", "ok");
      renderAll();
    });
  }

  // =========================================================================
  // GROUPS TAB — state.groups
  // =========================================================================
  function addGroup() {
    var name = (els.groupName.value || "").trim() || "Untitled group";
    rich.groups.push({ id: uuid(), name: name, enabled: false, flags: {} });
    els.groupName.value = "";
    saveState().then(renderAll);
  }

  function renderGroups() {
    els.groups.innerHTML = "";
    els.countGroups.textContent = String(rich.groups.length);
    if (!rich.groups.length) {
      var e = document.createElement("p");
      e.className = "empty";
      e.textContent = "No groups yet. Create one above.";
      els.groups.appendChild(e);
      return;
    }

    rich.groups.forEach(function (group) {
      var card = document.createElement("div");
      card.className = "card" + (group.enabled ? " on" : "");

      // head: enable toggle + editable name + delete
      var head = document.createElement("div");
      head.className = "card-head";

      var enable = document.createElement("input");
      enable.type = "checkbox";
      enable.checked = !!group.enabled;
      enable.title = "Apply this group globally";
      enable.addEventListener("change", function () {
        group.enabled = enable.checked;
        saveState().then(renderAll);
      });

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = group.name || "";
      nameInput.addEventListener("change", function () {
        group.name = nameInput.value.trim() || "Untitled group";
        saveState().then(renderGroups);
      });

      var del = document.createElement("button");
      del.className = "danger small";
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        rich.groups = rich.groups.filter(function (g) {
          return g.id !== group.id;
        });
        // also drop references from domains
        rich.domains.forEach(function (d) {
          d.groupIds = (d.groupIds || []).filter(function (id) {
            return id !== group.id;
          });
        });
        saveState().then(renderAll);
      });

      head.appendChild(enable);
      head.appendChild(nameInput);
      head.appendChild(del);
      card.appendChild(head);

      // existing flags as chips with editable values
      var chips = document.createElement("div");
      chips.className = "chiprow";
      var keys = Object.keys(group.flags || {});
      if (!keys.length) {
        var none = document.createElement("span");
        none.className = "sub";
        none.textContent = "No flags in this group.";
        chips.appendChild(none);
      }
      keys.forEach(function (k) {
        chips.appendChild(buildGroupFlagChip(group, k));
      });
      card.appendChild(chips);

      // add-flag row (picker of flags not already in the group)
      card.appendChild(buildAddFlagRow(group));

      els.groups.appendChild(card);
    });
  }

  // A chip for a flag inside a group: shows key + a value control + remove (x).
  function buildGroupFlagChip(group, key) {
    var flag = flagByKey(key) || { key: key, kind: "boolean" };
    var entry = group.flags[key] || { value: defaultValueFor(flag) };

    var chip = document.createElement("span");
    chip.className = "chip";

    var label = document.createElement("span");
    label.textContent = (flag.name && flag.name !== key ? flag.name : key) + ":";
    chip.appendChild(label);

    var ctrl = buildValueControl(flag, entry, false, function (patch) {
      var e = group.flags[key] || {};
      e.value = patch.value;
      if (typeof patch.variation === "number") e.variation = patch.variation;
      group.flags[key] = e;
      saveState().then(renderGroups);
    });
    ctrl.classList.add("cval");
    chip.appendChild(ctrl);

    var x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove from group";
    x.addEventListener("click", function () {
      delete group.flags[key];
      saveState().then(renderGroups);
    });
    chip.appendChild(x);
    return chip;
  }

  // Picker row to add a flag to a group/domain-overrides map.
  function buildAddFlagRow(group) {
    var row = document.createElement("div");
    row.className = "subrow";
    var sel = document.createElement("select");

    var avail = activeFlags().filter(function (f) {
      return f.clientSideAvailable !== false && !(group.flags && group.flags[f.key]);
    });
    if (!avail.length) {
      var opt = document.createElement("option");
      opt.textContent = "(all flags added)";
      opt.value = "";
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "Add flag…";
      sel.appendChild(ph);
      avail.forEach(function (f) {
        var o = document.createElement("option");
        o.value = f.key;
        o.textContent = f.name && f.name !== f.key ? f.name + " (" + f.key + ")" : f.key;
        sel.appendChild(o);
      });
    }

    var btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "Add";
    btn.disabled = !avail.length;
    btn.addEventListener("click", function () {
      var key = sel.value;
      if (!key) return;
      var flag = flagByKey(key);
      var entry = { value: defaultValueFor(flag) };
      if (flag && flag.kind === "boolean") entry.variation = boolVariation(false);
      group.flags[key] = entry;
      saveState().then(renderGroups);
    });

    row.appendChild(sel);
    row.appendChild(btn);
    return row;
  }

  // =========================================================================
  // DOMAINS TAB — state.domains
  // =========================================================================
  function addDomain() {
    var pattern = (els.domainPattern.value || "").trim().toLowerCase();
    if (!pattern) {
      setStatus(els.ldStatus, "", null);
      els.domainPattern.focus();
      return;
    }
    rich.domains.push({
      id: uuid(),
      name: pattern,
      pattern: pattern,
      matchType: els.domainMatchType.value || "suffix",
      enabled: true,
      groupIds: [],
      overrides: {},
    });
    els.domainPattern.value = "";
    saveState().then(renderAll);
  }

  function renderDomains() {
    els.domains.innerHTML = "";
    els.countDomains.textContent = String(rich.domains.length);
    if (!rich.domains.length) {
      var e = document.createElement("p");
      e.className = "empty";
      e.textContent = "No domain profiles. Add one above.";
      els.domains.appendChild(e);
      return;
    }

    rich.domains.forEach(function (domain) {
      domain.groupIds = domain.groupIds || [];
      domain.overrides = domain.overrides || {};

      var card = document.createElement("div");
      card.className = "card" + (domain.enabled ? " on" : "");

      // head: enable + pattern + matchType + delete
      var head = document.createElement("div");
      head.className = "card-head";

      var enable = document.createElement("input");
      enable.type = "checkbox";
      enable.checked = !!domain.enabled;
      enable.title = "Enable this profile";
      enable.addEventListener("change", function () {
        domain.enabled = enable.checked;
        saveState().then(renderAll);
      });

      var pat = document.createElement("input");
      pat.type = "text";
      pat.value = domain.pattern || "";
      pat.addEventListener("change", function () {
        domain.pattern = (pat.value || "").trim().toLowerCase();
        domain.name = domain.pattern;
        saveState().then(renderDomains);
      });

      var mt = document.createElement("select");
      [["suffix", "suffix"], ["exact", "exact"], ["glob", "glob"]].forEach(function (p) {
        var o = document.createElement("option");
        o.value = p[0];
        o.textContent = p[1];
        mt.appendChild(o);
      });
      mt.value = domain.matchType || "suffix";
      mt.addEventListener("change", function () {
        domain.matchType = mt.value;
        saveState().then(renderDomains);
      });

      var del = document.createElement("button");
      del.className = "danger small";
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        rich.domains = rich.domains.filter(function (d) {
          return d.id !== domain.id;
        });
        saveState().then(renderAll);
      });

      head.appendChild(enable);
      head.appendChild(pat);
      head.appendChild(mt);
      head.appendChild(del);
      card.appendChild(head);

      var hint = document.createElement("p");
      hint.className = "help";
      hint.textContent =
        domain.matchType === "suffix"
          ? "Matches " + (domain.pattern || "…") + " and all subdomains."
          : domain.matchType === "exact"
          ? "Matches exactly " + (domain.pattern || "…") + "."
          : "Glob match (use * as wildcard).";
      card.appendChild(hint);

      // group activations for this domain
      if (rich.groups.length) {
        var gt = document.createElement("div");
        gt.className = "grouptoggles";
        var gtLabel = document.createElement("div");
        gtLabel.className = "sub";
        gtLabel.textContent = "Activate groups on this domain:";
        gt.appendChild(gtLabel);
        rich.groups.forEach(function (g) {
          var lbl = document.createElement("label");
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = domain.groupIds.indexOf(g.id) >= 0;
          cb.addEventListener("change", function () {
            if (cb.checked) {
              if (domain.groupIds.indexOf(g.id) < 0) domain.groupIds.push(g.id);
            } else {
              domain.groupIds = domain.groupIds.filter(function (id) {
                return id !== g.id;
              });
            }
            saveState().then(renderDomains);
          });
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(g.name || "Untitled group"));
          gt.appendChild(lbl);
        });
        card.appendChild(gt);
      }

      // domain-specific individual overrides (chips)
      var chips = document.createElement("div");
      chips.className = "chiprow";
      var ovLabel = document.createElement("div");
      ovLabel.className = "sub";
      ovLabel.textContent = "Domain-specific overrides:";
      chips.appendChild(ovLabel);
      var keys = Object.keys(domain.overrides);
      keys.forEach(function (k) {
        chips.appendChild(buildDomainOverrideChip(domain, k));
      });
      card.appendChild(chips);

      // add override row
      card.appendChild(buildAddDomainOverrideRow(domain));

      els.domains.appendChild(card);
    });
  }

  function buildDomainOverrideChip(domain, key) {
    var flag = flagByKey(key) || { key: key, kind: "boolean" };
    var entry = domain.overrides[key] || { value: defaultValueFor(flag) };

    var chip = document.createElement("span");
    chip.className = "chip";

    // domain overrides carry per-entry enabled; reflect/allow toggling it.
    var en = document.createElement("input");
    en.type = "checkbox";
    en.checked = entry.enabled === true;
    en.title = "Enabled";
    en.addEventListener("change", function () {
      domain.overrides[key].enabled = en.checked;
      saveState().then(renderDomains);
    });
    chip.appendChild(en);

    var label = document.createElement("span");
    label.textContent = (flag.name && flag.name !== key ? flag.name : key) + ":";
    chip.appendChild(label);

    var ctrl = buildValueControl(flag, entry, !en.checked, function (patch) {
      var e = domain.overrides[key] || { enabled: true };
      e.value = patch.value;
      if (typeof patch.variation === "number") e.variation = patch.variation;
      domain.overrides[key] = e;
      saveState().then(renderDomains);
    });
    ctrl.classList.add("cval");
    chip.appendChild(ctrl);

    var x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", function () {
      delete domain.overrides[key];
      saveState().then(renderDomains);
    });
    chip.appendChild(x);
    return chip;
  }

  function buildAddDomainOverrideRow(domain) {
    var row = document.createElement("div");
    row.className = "subrow";
    var sel = document.createElement("select");
    var avail = activeFlags().filter(function (f) {
      return f.clientSideAvailable !== false && !domain.overrides[f.key];
    });
    if (!avail.length) {
      var opt = document.createElement("option");
      opt.textContent = "(all flags added)";
      opt.value = "";
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "Add override…";
      sel.appendChild(ph);
      avail.forEach(function (f) {
        var o = document.createElement("option");
        o.value = f.key;
        o.textContent = f.name && f.name !== f.key ? f.name + " (" + f.key + ")" : f.key;
        sel.appendChild(o);
      });
    }
    var btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "Add";
    btn.disabled = !avail.length;
    btn.addEventListener("click", function () {
      var key = sel.value;
      if (!key) return;
      var flag = flagByKey(key);
      var entry = { value: defaultValueFor(flag), enabled: true };
      if (flag && flag.kind === "boolean") entry.variation = boolVariation(false);
      domain.overrides[key] = entry;
      saveState().then(renderDomains);
    });
    row.appendChild(sel);
    row.appendChild(btn);
    return row;
  }

  // =========================================================================
  // render orchestration + tabs
  // =========================================================================
  function renderAll() {
    renderFlags();
    renderOverrideSummary();
    renderGroups();
    renderDomains();
  }

  function activateTab(name) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].dataset.tab === name);
    }
    var panels = document.querySelectorAll(".panel");
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle("active", panels[j].id === "panel-" + name);
    }
  }

  // ---- wire up events -----------------------------------------------------
  // tabs
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      activateTab(t.dataset.tab);
    });
  });
  // settings
  els.save.addEventListener("click", saveSettings);
  els.test.addEventListener("click", testConnection);
  els.forget.addEventListener("click", forgetToken);
  els.project.addEventListener("change", function () {
    populateEnvDropdown();
    persistSelection();
  });
  els.env.addEventListener("change", function () {
    updateClientSideId();
    persistSelection();
  });
  els.syncBtn.addEventListener("click", function () {
    syncFlags(false);
  });
  els.refresh.addEventListener("click", function () {
    syncFlags(true);
  });
  // flags
  els.flagSearch.addEventListener("input", function () {
    flagFilter = els.flagSearch.value;
    renderFlags();
  });
  // manual add-flag
  els.manualType.addEventListener("change", function () {
    setStatus(els.manualStatus, "", null);
    renderManualValueControl();
  });
  els.manualAddBtn.addEventListener("click", addManualFlag);
  els.manualKey.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addManualFlag();
  });
  renderManualValueControl(); // initial control for the default type
  // backup: export / import
  els.exportBtn.addEventListener("click", exportConfig);
  els.importBtn.addEventListener("click", function () {
    els.importFile.value = ""; // allow re-importing the same file
    els.importFile.click();
  });
  els.importFile.addEventListener("change", function () {
    var file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      importConfigFromText(String(reader.result || ""));
    };
    reader.onerror = function () {
      setStatus(els.backupStatus, "Could not read file.", "err");
    };
    reader.readAsText(file);
  });
  // groups
  els.groupAdd.addEventListener("click", addGroup);
  els.groupName.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addGroup();
  });
  // domains
  els.domainAdd.addEventListener("click", addDomain);
  els.domainPattern.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addDomain();
  });
  // footer: clear ALL override data (global overrides + groups + domains)
  els.clear.addEventListener("click", function () {
    rich = { version: 1, globalOverrides: {}, groups: [], domains: [] };
    saveState().then(renderAll);
  });

  // ---- init ---------------------------------------------------------------
  function init() {
    // Read everything we need, including legacy key so migrate() can absorb it.
    return get([K_STATE, "flagswap:overrides", K_TOKEN, K_BASEURL, K_SEL]).then(function (res) {
      // migrate() handles legacy flagswap:overrides -> globalOverrides.
      rich = State
        ? State.migrate(res)
        : { version: 1, globalOverrides: res["flagswap:overrides"] || {}, groups: [], domains: [] };
      // ensure shape
      rich.version = 1;
      rich.globalOverrides = rich.globalOverrides || {};
      rich.groups = rich.groups || [];
      rich.domains = rich.domains || [];

      selection = res[K_SEL] || {};
      if (res[K_BASEURL]) els.base.value = res[K_BASEURL];
      var hasToken = !!res[K_TOKEN];
      if (hasToken) els.token.placeholder = "•••••••• (saved — type to replace)";

      updateSourceNote();
      renderAll(); // demo first; cache/sync may replace the flag list below

      // One-time migration write: if there is NO flagswap:state yet but legacy
      // flagswap:overrides exists, persist the migrated result under
      // flagswap:state so the popup owns the new key going forward. We do NOT
      // write an empty state for brand-new users (avoids creating a key that
      // would shadow a later legacy seed) — the first user edit creates it.
      var hadState = res[K_STATE] && typeof res[K_STATE] === "object";
      var hadLegacy = res["flagswap:overrides"] && typeof res["flagswap:overrides"] === "object";
      var promise = !hadState && hadLegacy ? saveState() : Promise.resolve();

      return promise.then(function () {
        return loadCachedSelection().then(function () {
          if (!hasToken) return;
          return loadProjects().then(function () {
            if (selection.projectKey && selection.envKey) {
              if (projects.some(function (p) { return p.key === selection.projectKey; })) {
                els.project.value = selection.projectKey;
                populateEnvDropdown();
                els.env.value = selection.envKey;
                updateClientSideId();
              }
            }
          });
        });
      });
    });
  }

  init();
})();
