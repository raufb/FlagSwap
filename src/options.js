/*
 * FlagSwap settings page (options.js).
 *
 * Owns: LaunchDarkly connection, project/env sync, manual flag type management,
 * and backup (export/import). These are "set once" operations moved out of the
 * popup so the popup can stay focused on day-to-day flag toggling.
 *
 * Reads + writes the same storage keys as popup.js:
 *   flagswap:state   — rich state (globalOverrides / groups / domains)
 *   flagswap:ldToken — LD API token
 *   flagswap:ldBaseUrl, flagswap:ldSelection — connection prefs
 *   flagswap:flagCache:<proj>:<env> — synced flag list
 */
(function () {
  "use strict";

  var State = window.__FlagSwapState;

  var K_STATE   = "flagswap:state";
  var K_TOKEN   = "flagswap:ldToken";
  var K_BASEURL = "flagswap:ldBaseUrl";
  var K_SEL     = "flagswap:ldSelection";
  var K_DISC    = "flagswap:discoveredFlags";

  function cacheKey(proj, env) { return "flagswap:flagCache:" + proj + ":" + env; }

  var rich = { version: 1, globalOverrides: {}, groups: [], domains: [] };
  var projects = [];
  var selection = {};
  var discoveredFlags = {};

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    token: $("ld-token"), base: $("ld-base"),
    save: $("ld-save"), test: $("ld-test"), forget: $("ld-forget"),
    ldStatus: $("ld-status"),
    sync: $("sync"),
    project: $("ld-project"), env: $("ld-env"), csid: $("ld-csid"),
    syncBtn: $("ld-sync"), refresh: $("ld-refresh"), syncStatus: $("sync-status"),
    manualKey: $("manual-key"), manualType: $("manual-type"),
    manualValueHost: $("manual-value-host"),
    manualAddBtn: $("manual-add-btn"), manualStatus: $("manual-status"),
    manualFlagsList: $("manual-flags-list"),
    discoveredKeys: $("discovered-keys"),
    exportBtn: $("export-btn"), importBtn: $("import-btn"),
    importFile: $("import-file"), backupStatus: $("backup-status"),
  };

  // ---- storage helpers -------------------------------------------------------
  function get(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
    });
  }
  function set(obj) {
    return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
  }
  function remove(keys) {
    return new Promise(function (resolve) { chrome.storage.local.remove(keys, resolve); });
  }
  function saveState() {
    var o = {}; o[K_STATE] = rich; return set(o);
  }

  // ---- SW messaging ----------------------------------------------------------
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

  // ---- LD connection --------------------------------------------------------
  function saveSettings() {
    var token = els.token.value.trim();
    var base  = els.base.value;
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
    return saveSettings().then(function () {
      return sendSW({ type: "ld:test" });
    }).then(function (res) {
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
      els.token.placeholder = "api-xxxxxxxx";
      setStatus(els.ldStatus, "Token removed.", null);
      els.sync.style.display = "none";
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
    return projects.find(function (p) { return p.key === els.project.value; });
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
    var o = {}; o[K_SEL] = selection; return set(o);
  }

  function timeAgo(ts) {
    if (!ts) return "unknown";
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  function syncFlags(force) {
    var proj = els.project.value;
    var env  = els.env.value;
    if (!proj || !env) return Promise.resolve();
    persistSelection();
    var ck = cacheKey(proj, env);
    var doFetch = function () {
      setStatus(els.syncStatus, "Syncing flags…", null);
      return sendSW({ type: "ld:flags", projectKey: proj, envKey: env }).then(function (res) {
        if (!res.ok) { setStatus(els.syncStatus, "Sync failed: " + res.message, "err"); return; }
        var cacheObj = {};
        cacheObj[ck] = { flags: res.flags || [], ts: Date.now() };
        return set(cacheObj).then(function () {
          setStatus(els.syncStatus, "Synced " + (res.flags || []).length + " flag(s).", "ok");
        });
      });
    };
    if (force) return doFetch();
    return get(ck).then(function (res) {
      var cached = res[ck];
      if (cached && Array.isArray(cached.flags)) {
        setStatus(els.syncStatus, "Cached " + cached.flags.length + " flag(s) (" + timeAgo(cached.ts) + "). Use Force refresh to update.", null);
        return;
      }
      return doFetch();
    });
  }

  // ---- manual flag management -----------------------------------------------
  function inferKind(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number")  return "number";
    if (value !== null && typeof value === "object") return "json";
    return "string";
  }

  function renderManualValueControl() {
    var host = els.manualValueHost;
    host.innerHTML = "";
    var type = els.manualType.value;
    if (type === "boolean") {
      var wrap = document.createElement("span");
      wrap.className = "val";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "toggle";
      cb.id = "manual-value";
      var lbl = document.createElement("span");
      lbl.textContent = cb.checked ? "true" : "false";
      cb.addEventListener("change", function () { lbl.textContent = cb.checked ? "true" : "false"; });
      wrap.appendChild(cb); wrap.appendChild(lbl);
      host.appendChild(wrap);
    } else if (type === "json") {
      var ta = document.createElement("textarea");
      ta.id = "manual-value"; ta.rows = 3;
      ta.placeholder = '{ "key": "value" }';
      ta.style.width = "100%"; ta.style.font = "inherit";
      host.appendChild(ta);
    } else {
      var t = document.createElement("input");
      t.type = "text"; t.id = "manual-value";
      t.placeholder = type === "number" ? "42" : "some text";
      host.appendChild(t);
    }
  }

  function readManualValue() {
    var type = els.manualType.value;
    var el = document.getElementById("manual-value");
    if (type === "boolean") return { ok: true, value: !!(el && el.checked) };
    var raw = el ? el.value : "";
    if (type === "number") {
      var n = Number(raw);
      if (raw.trim() === "" || isNaN(n)) return { ok: false, error: "Not a valid number." };
      return { ok: true, value: n };
    }
    if (type === "json") {
      try { return { ok: true, value: JSON.parse(raw) }; }
      catch (e) { return { ok: false, error: "Invalid JSON: " + e.message }; }
    }
    return { ok: true, value: raw };
  }

  function boolVariation(v) { return v ? 0 : 1; }

  function addManualFlag() {
    var key = (els.manualKey.value || "").trim();
    if (!key) { setStatus(els.manualStatus, "Flag key is required.", "err"); els.manualKey.focus(); return; }
    var parsed = readManualValue();
    if (!parsed.ok) { setStatus(els.manualStatus, parsed.error, "err"); return; }
    var manualType = els.manualType.value;
    var entry = { value: parsed.value, enabled: true, _kind: manualType };
    if (manualType === "boolean") entry.variation = boolVariation(parsed.value === true);
    rich.globalOverrides[key] = entry;
    saveState().then(function () {
      setStatus(els.manualStatus, "Added "" + key + "".", "ok");
      els.manualKey.value = "";
      renderManualValueControl();
      renderManualFlagsList();
    });
  }

  function renderManualFlagsList() {
    var container = els.manualFlagsList;
    container.innerHTML = "";
    var keys = Object.keys(rich.globalOverrides).filter(function (k) {
      return rich.globalOverrides[k] && rich.globalOverrides[k]._kind;
    });
    if (!keys.length) {
      var p = document.createElement("p");
      p.className = "help";
      p.textContent = "No manual flag overrides yet.";
      container.appendChild(p);
      return;
    }
    keys.forEach(function (key) {
      var ov = rich.globalOverrides[key];
      var row = document.createElement("div");
      row.className = "manual-flag-entry";

      var keyLabel = document.createElement("span");
      keyLabel.className = "mfe-key";
      keyLabel.textContent = key;
      row.appendChild(keyLabel);

      // Type selector
      var typeSel = document.createElement("select");
      ["boolean", "string", "number", "json"].forEach(function (t) {
        var opt = document.createElement("option");
        opt.value = t; opt.textContent = t;
        if (t === (ov._kind || inferKind(ov.value))) opt.selected = true;
        typeSel.appendChild(opt);
      });
      typeSel.addEventListener("change", function () {
        rich.globalOverrides[key]._kind = typeSel.value;
        saveState();
      });
      row.appendChild(typeSel);

      var rmBtn = document.createElement("button");
      rmBtn.className = "danger small";
      rmBtn.textContent = "Remove";
      rmBtn.addEventListener("click", function () {
        delete rich.globalOverrides[key];
        saveState().then(renderManualFlagsList);
      });
      row.appendChild(rmBtn);
      container.appendChild(row);
    });
  }

  // ---- datalist from discovered flags ----------------------------------------
  function populateDiscoveredKeys() {
    els.discoveredKeys.innerHTML = "";
    Object.keys(discoveredFlags).forEach(function (key) {
      var opt = document.createElement("option");
      opt.value = key;
      els.discoveredKeys.appendChild(opt);
    });
    // Auto-fill type when a discovered key is chosen
    els.manualKey.addEventListener("input", function () {
      var disc = discoveredFlags[els.manualKey.value.trim()];
      if (disc && disc.kind) els.manualType.value = disc.kind;
    });
  }

  // ---- backup ---------------------------------------------------------------
  var EXPORT_FORMAT = "flagswap-config";

  function buildExportObject(state) {
    return {
      format: EXPORT_FORMAT, version: 1,
      exportedAt: new Date().toISOString(),
      state: {
        version: 1,
        globalOverrides: (state && state.globalOverrides) || {},
        groups:  (state && state.groups)  || [],
        domains: (state && state.domains) || [],
      },
    };
  }

  function dateStamp() { return new Date().toISOString().slice(0, 10); }

  function exportConfig() {
    try {
      var text = JSON.stringify(buildExportObject(rich), null, 2);
      var blob = new Blob([text], { type: "application/json" });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement("a");
      a.href = url;
      a.download = "flagswap-config-" + dateStamp() + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      setStatus(els.backupStatus, "Exported config.", "ok");
    } catch (e) {
      setStatus(els.backupStatus, "Export failed: " + e.message, "err");
    }
  }

  function importConfigFromText(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { setStatus(els.backupStatus, "Import failed: invalid JSON.", "err"); return; }
    var candidate = (parsed && parsed.state && typeof parsed.state === "object") ? parsed.state : parsed;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      setStatus(els.backupStatus, "Import failed: unrecognized file shape.", "err"); return;
    }
    var safe = State
      ? State.migrate({ "flagswap:state": candidate })
      : { version: 1, globalOverrides: candidate.globalOverrides || {}, groups: candidate.groups || [], domains: candidate.domains || [] };
    if (!confirm("Replace your current FlagSwap config with the imported file?")) {
      setStatus(els.backupStatus, "Import cancelled.", null); return;
    }
    rich = safe;
    saveState().then(function () {
      setStatus(els.backupStatus, "Imported config.", "ok");
      renderManualFlagsList();
    });
  }

  // ---- wire up ---------------------------------------------------------------
  els.save.addEventListener("click", saveSettings);
  els.test.addEventListener("click", testConnection);
  els.forget.addEventListener("click", forgetToken);
  els.project.addEventListener("change", function () { populateEnvDropdown(); persistSelection(); });
  els.env.addEventListener("change", function () { updateClientSideId(); persistSelection(); });
  els.syncBtn.addEventListener("click", function () { syncFlags(false); });
  els.refresh.addEventListener("click", function () { syncFlags(true); });
  els.manualType.addEventListener("change", function () { setStatus(els.manualStatus, "", null); renderManualValueControl(); });
  els.manualAddBtn.addEventListener("click", addManualFlag);
  els.manualKey.addEventListener("keydown", function (e) { if (e.key === "Enter") addManualFlag(); });
  els.exportBtn.addEventListener("click", exportConfig);
  els.importBtn.addEventListener("click", function () { els.importFile.value = ""; els.importFile.click(); });
  els.importFile.addEventListener("change", function () {
    var file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { importConfigFromText(String(reader.result || "")); };
    reader.onerror = function () { setStatus(els.backupStatus, "Could not read file.", "err"); };
    reader.readAsText(file);
  });

  renderManualValueControl();

  // ---- init -----------------------------------------------------------------
  function init() {
    return get([K_STATE, "flagswap:overrides", K_TOKEN, K_BASEURL, K_SEL, K_DISC]).then(function (res) {
      rich = State
        ? State.migrate(res)
        : { version: 1, globalOverrides: res["flagswap:overrides"] || {}, groups: [], domains: [] };
      rich.version = 1;
      rich.globalOverrides = rich.globalOverrides || {};
      rich.groups  = rich.groups  || [];
      rich.domains = rich.domains || [];

      selection = res[K_SEL] || {};
      discoveredFlags = res[K_DISC] || {};
      if (res[K_BASEURL]) els.base.value = res[K_BASEURL];
      if (res[K_TOKEN])   els.token.placeholder = "•••••••• (saved — type to replace)";

      populateDiscoveredKeys();
      renderManualFlagsList();

      if (res[K_TOKEN]) {
        return loadProjects().then(function () {
          if (selection.projectKey && projects.some(function (p) { return p.key === selection.projectKey; })) {
            els.project.value = selection.projectKey;
            populateEnvDropdown();
            if (selection.envKey) {
              els.env.value = selection.envKey;
              updateClientSideId();
            }
            // Show cached status
            var ck = cacheKey(selection.projectKey, selection.envKey);
            return get(ck).then(function (r) {
              var cached = r[ck];
              if (cached && Array.isArray(cached.flags)) {
                setStatus(els.syncStatus, "Cached " + cached.flags.length + " flag(s) (" + timeAgo(cached.ts) + "). Use Force refresh to update.", null);
              }
            });
          }
        });
      }
    });
  }

  init();
})();
