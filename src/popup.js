/*
 * FlagSwap popup UI.
 *
 * Day-to-day workflow: toggle flag overrides, enable/disable groups, manage
 * domain profiles. One-time setup (LD connection, sync, backup, flag types)
 * lives in the Settings page (options.html).
 *
 * State schema (flagswap:state):
 *   { version:1, globalOverrides:{[key]:{value,variation?,enabled,_kind?}},
 *     groups:[...], domains:[...] }
 */
(function () {
  "use strict";

  var State = window.__FlagSwapState;

  // ---- storage keys -------------------------------------------------------
  var K_STATE = "flagswap:state";
  var K_TOKEN = "flagswap:ldToken";
  var K_SEL   = "flagswap:ldSelection";
  var K_DISC  = "flagswap:discoveredFlags";
  function cacheKey(proj, env) { return "flagswap:flagCache:" + proj + ":" + env; }

  // ---- in-memory state ----------------------------------------------------
  var rich = { version: 1, globalOverrides: {}, groups: [], domains: [] };
  var flags = null;         // synced flag list (null = no sync yet)
  var flagsCacheVer = 0;    // schema ver of the loaded flag cache (2 = has served values)
  var flagFilter = "";
  var discoveredFlags = {}; // {[key]: {kind, value?}} from intercepted LD eval responses
  var showServerSide = false;
  var sortField = "name";
  var sortAsc = true;

  // Are we rendered inside a docked side panel / sidebar, or the popup?
  // The panel/sidebar manifest entries load popup.html with ?ctx=panel.
  var ctx = (function () {
    try { return new URLSearchParams(location.search).get("ctx") || "popup"; }
    catch (e) { return "popup"; }
  })();
  var isPanel = ctx === "panel";

  // ---- DOM refs -----------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    sourceNote: $("source-note"),
    settingsBtn: $("settings-btn"),
    refreshBtn: $("refresh-btn"),
    dockBtn: $("dock-btn"),
    tabFlags: $("tab-flags"),
    countFlags: $("count-flags"), countGroups: $("count-groups"), countDomains: $("count-domains"),
    flagSearch: $("flag-search"),
    overrideSummary: $("override-summary"),
    flags: $("flags"),
    manualKey: $("manual-key"),
    manualAddBtn: $("manual-add-btn"),
    manualStatus: $("manual-status"),
    gotoSettings: $("goto-settings"),
    discoveredKeys: $("discovered-keys"),
    groupName: $("group-name"), groupAdd: $("group-add"), groups: $("groups"),
    domainPattern: $("domain-pattern"), domainMatchType: $("domain-matchtype"),
    domainAdd: $("domain-add"), domains: $("domains"),
    clear: $("clear"), cacheInfo: $("cache-info"),
    flagSort: $("flag-sort"), flagSortDir: $("flag-sort-dir"),
    showServerSide: $("show-server-side"),
  };

  // ---- storage helpers ----------------------------------------------------
  function get(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
    });
  }
  function set(obj) {
    return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
  }
  function saveState() {
    var o = {}; o[K_STATE] = rich; return set(o);
  }
  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  // ---- flag metadata helpers ---------------------------------------------
  function activeFlags() { return flags || []; }
  function flagByKey(key) {
    return activeFlags().find(function (f) { return f.key === key; });
  }
  function isMultivariate(flag) {
    return !!(flag && flag.kind === "multivariate" && flag.variations && flag.variations.length);
  }
  function defaultValueFor(flag) {
    if (!flag) return true;
    if (flag.kind === "boolean") return true;
    return isMultivariate(flag) ? flag.variations[0].value : "";
  }
  function boolVariation(v) { return v ? 0 : 1; }
  function display(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  // Infer kind from a stored value — last resort when no _kind stored.
  function inferKind(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number")  return "number";
    if (value !== null && typeof value === "object") return "json";
    return "string";
  }

  // Determine the display kind for any flag (synced, manual, or unknown).
  function flagKind(flag) {
    if (flag.kind) return flag.kind;                              // synced LD flag
    var ov = rich.globalOverrides[flag.key];
    if (ov && ov._kind) return ov._kind;                         // stored kind
    if (discoveredFlags[flag.key]) return discoveredFlags[flag.key].kind; // discovered
    if (ov) return inferKind(ov.value);                          // infer from value
    return "boolean";                                            // default for unknown
  }

  // ---- source note (connection status) ------------------------------------
  function updateSourceNote() {
    if (flags && flags.length) {
      var ssCount = flags.filter(function (f) { return f.clientSideAvailable === false; }).length;
      var note = "Showing " + flags.length + " synced flag(s)";
      if (ssCount && !showServerSide) note += " (" + ssCount + " server-side hidden)";
      note += ".";
      // Pre-v2 caches lack served-value data, so default states fall back to the
      // raw `on` bit and can be wrong. Nudge a re-sync to pick up real defaults.
      if (flagsCacheVer && flagsCacheVer < 2) {
        note += " Force-refresh in Settings for accurate default states.";
      }
      els.sourceNote.textContent = note;
    } else {
      els.sourceNote.textContent = flags
        ? "0 flags synced — check Settings to re-sync."
        : "No flags synced — add manually below, or connect via Settings.";
    }
  }

  function loadCachedFlags(selection) {
    if (!selection || !selection.projectKey || !selection.envKey) return Promise.resolve();
    var ck = cacheKey(selection.projectKey, selection.envKey);
    return get(ck).then(function (res) {
      var cached = res[ck];
      if (cached && Array.isArray(cached.flags)) {
        flags = cached.flags;
        flagsCacheVer = typeof cached.ver === "number" ? cached.ver : 1;
        updateSourceNote();
        renderAll();
      }
    });
  }

  // =========================================================================
  // FLAGS TAB — individual global overrides
  // =========================================================================
  function displayedFlags() {
    var base = activeFlags();
    var seen = {};
    var out  = [];
    base.forEach(function (f) {
      if (!showServerSide && f.clientSideAvailable === false) return;
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

  function sortFlags(list) {
    return list.slice().sort(function (a, b) {
      var cmp = 0;
      if (sortField === "name") {
        var na = (a.name || a.key).toLowerCase();
        var nb = (b.name || b.key).toLowerCase();
        cmp = na < nb ? -1 : na > nb ? 1 : 0;
      } else if (sortField === "override") {
        var oa = !!(rich.globalOverrides[a.key] && rich.globalOverrides[a.key].enabled);
        var ob = !!(rich.globalOverrides[b.key] && rich.globalOverrides[b.key].enabled);
        cmp = (ob ? 1 : 0) - (oa ? 1 : 0);
      } else if (sortField === "status") {
        var ra = a.on === true ? 0 : a.on === false ? 1 : 2;
        var rb = b.on === true ? 0 : b.on === false ? 1 : 2;
        cmp = ra - rb;
      } else if (sortField === "side") {
        var sa = a.clientSideAvailable === false ? 1 : 0;
        var sb = b.clientSideAvailable === false ? 1 : 0;
        cmp = sa - sb;
      }
      return sortAsc ? cmp : -cmp;
    });
  }

  // Build one flag row: [override-toggle] [name] [value-control | default-badge].
  // Left toggle = "is an override active?" — same meaning for EVERY flag kind,
  // and toggling it off clears the override. The right side shows the value
  // control while overriding (a value toggle for booleans, a dropdown for
  // multivariate, a text input otherwise), or the flag's real default when not.
  function buildFlagRow(flag) {
    var serverSide  = flag.clientSideAvailable === false;
    var ov          = rich.globalOverrides[flag.key];
    var hasOverride = !!(ov && ov.enabled === true);
    var kind        = flagKind(flag);
    var isBool      = kind === "boolean";
    var isMulti     = isMultivariate(flag);

    var row = document.createElement("div");
    row.className = "flag-row" +
      (hasOverride ? " overriding" : "") +
      (serverSide  ? " ss" : "");

    // Effective default with no override, in priority order:
    //   flag.value — LD's served variation value from sync (fallthrough when on,
    //                offVariation when off): what the flag actually RESOLVES to,
    //                which is not the same as the raw `on` targeting bit.
    //   disc.value — value observed live by the interceptor on this page.
    //   flag.on    — last resort: raw targeting on/off (pre-served-value caches).
    // Seeds a freshly-enabled override and drives the no-override default badge.
    var disc = discoveredFlags[flag.key];
    var baseVal, baseSource;
    if (flag.value !== undefined)              { baseVal = flag.value; baseSource = "ld"; }
    else if (disc && disc.value !== undefined) { baseVal = disc.value; baseSource = "observed"; }
    else if (flag.on !== undefined)            { baseVal = flag.on;    baseSource = "targeting"; }

    // Left toggle: enable/disable an override of ANY type.
    var ovToggle = document.createElement("input");
    ovToggle.type = "checkbox";
    ovToggle.className = "toggle ov-toggle";
    ovToggle.checked = hasOverride;
    ovToggle.disabled = serverSide;
    ovToggle.title = serverSide ? "Server-side flag — can't override"
                   : hasOverride ? "Override active — click to clear"
                   : "Enable override";
    if (!serverSide) {
      ovToggle.addEventListener("change", function () {
        if (ovToggle.checked) {
          rich.globalOverrides[flag.key] = seedOverride(flag, ov, baseVal, isBool, isMulti);
        } else {
          delete rich.globalOverrides[flag.key];
        }
        saveState().then(renderAll);
      });
    }

    // Label
    var lbl = document.createElement("div");
    lbl.className = "flag-label";
    var nameEl = document.createElement("span");
    nameEl.className = "fname";
    nameEl.textContent = flag.name || flag.key;
    lbl.appendChild(nameEl);
    if (flag.name && flag.name !== flag.key) {
      var keyEl = document.createElement("span");
      keyEl.className = "fkey";
      keyEl.textContent = flag.key;
      lbl.appendChild(keyEl);
    }

    // Right side: value control while overriding, else the default badge.
    var ctrls = document.createElement("div");
    ctrls.className = "flag-controls";
    if (serverSide) {
      var ssNote = document.createElement("span");
      ssNote.className = "muted";
      ssNote.style.fontSize = "10.5px";
      ssNote.textContent = "server-side";
      ctrls.appendChild(ssNote);
    } else if (hasOverride) {
      ctrls.appendChild(buildOverrideValueControl(flag, ov));
    } else {
      var badge = buildDefaultBadge(baseVal, baseSource);
      if (badge) ctrls.appendChild(badge);
    }

    row.appendChild(ovToggle);
    row.appendChild(lbl);
    row.appendChild(ctrls);
    return row;
  }

  // Find the variation index whose value matches `val` (0 if none/absent).
  function variationIndexFor(flag, val) {
    if (!flag.variations) return 0;
    var i = flag.variations.findIndex(function (v) {
      return JSON.stringify(v.value) === JSON.stringify(val);
    });
    return i >= 0 ? i : 0;
  }

  // Build the override entry for a newly-enabled override.
  // Booleans seed at the OPPOSITE of the current default (baseVal): the reason
  // you enable an override is almost always to force the non-default value, so
  // one click does it. Multivariate/string have no "opposite" — they seed at
  // the current default and you pick the value with the right-side control.
  function seedOverride(flag, existingOv, baseVal, isBool, isMulti) {
    var existing = existingOv || {};
    if (isBool) {
      var bv = existing.value !== undefined ? existing.value === true : baseVal !== true;
      return { value: bv, enabled: true, _kind: "boolean", variation: boolVariation(bv) };
    }
    if (isMulti) {
      var seed = existing.value !== undefined ? existing.value : baseVal;
      var vi = variationIndexFor(flag, seed);
      return { value: flag.variations[vi].value, enabled: true, variation: vi };
    }
    var entry = {
      value: existing.value !== undefined ? existing.value
           : baseVal !== undefined ? baseVal : defaultValueFor(flag),
      enabled: true,
    };
    var fk = flagKind(flag);
    if (fk && fk !== "boolean" && fk !== "multivariate") entry._kind = fk;
    return entry;
  }

  // The right-side value control shown while a GLOBAL override is active.
  // Thin wrapper over the shared buildValueControl, persisting to globalOverrides.
  function buildOverrideValueControl(flag, ov) {
    return buildValueControl(flag, ov, false, function (patch) {
      var e = Object.assign({}, rich.globalOverrides[flag.key] || {}, { enabled: true });
      e.value = patch.value;
      if (typeof patch.variation === "number") e.variation = patch.variation;
      if (flagKind(flag) === "boolean") e._kind = "boolean";
      rich.globalOverrides[flag.key] = e;
      saveState();
    });
  }

  // Coerce a text-input override value to its stored kind.
  function coerceByKind(raw, kind) {
    if (kind === "number") { var n = Number(raw); return isNaN(n) ? raw : n; }
    if (kind === "json")   { try { return JSON.parse(raw); } catch (e) { return raw; } }
    return raw;
  }

  // Grey badge showing the flag's real default value when no override is active.
  function buildDefaultBadge(baseVal, baseSource) {
    if (baseVal === undefined) return null;
    var defStatus, defClass;
    if (baseVal === true || baseVal === false) {
      defStatus = baseVal ? "on" : "off";
      defClass  = baseVal ? "ds-on" : "ds-off";
    } else {
      defStatus = String(baseVal).slice(0, 6);
      defClass  = "ds-val";
    }
    var dsBadge = document.createElement("span");
    dsBadge.className = "default-status " + defClass;
    dsBadge.textContent = defStatus;
    dsBadge.title = (baseSource === "ld" ? "LD default: "
                   : baseSource === "observed" ? "Observed default: "
                   : "LD targeting: ") + display(baseVal);
    return dsBadge;
  }

  // Minimal variation <select> for multivariate flags.
  function buildVariationSelect(flag, entry, onChange) {
    var sel = document.createElement("select");
    sel.style.maxWidth = "100px";
    sel.style.fontSize = "11px";
    flag.variations.forEach(function (v, idx) {
      var opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = v.name || display(v.value).slice(0, 20);
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

  // Unified value control for an override entry — shared by the Flags, Groups
  // and Domains tabs. boolean -> value toggle + true/false label; multivariate
  // -> variation <select>; else -> text input (coerced to the stored kind). The
  // control self-updates its display and calls onChange({value, variation?}) to
  // persist. `disabled` greys it (e.g. a paused domain override).
  function buildValueControl(flag, entry, disabled, onChange) {
    if (isMultivariate(flag)) {
      var sel = buildVariationSelect(flag, entry, onChange);
      sel.disabled = !!disabled;
      return sel;
    }
    if (flagKind(flag) === "boolean") {
      var wrap = document.createElement("span");
      wrap.className = "bool-val";
      var tog = document.createElement("input");
      tog.type = "checkbox";
      tog.className = "toggle";
      tog.checked = entry.value === true;
      tog.disabled = !!disabled;
      tog.title = "Override value (true / false)";
      var lbl = document.createElement("span");
      lbl.className = "bool-val-label" + (tog.checked ? " on" : "");
      lbl.textContent = tog.checked ? "true" : "false";
      tog.addEventListener("change", function () {
        lbl.textContent = tog.checked ? "true" : "false";
        lbl.className = "bool-val-label" + (tog.checked ? " on" : "");
        onChange({ value: tog.checked, variation: boolVariation(tog.checked) });
      });
      wrap.appendChild(tog);
      wrap.appendChild(lbl);
      return wrap;
    }
    var inp = document.createElement("input");
    inp.type = "text";
    inp.className = "ov-input";
    inp.value = entry.value == null ? "" : String(entry.value);
    inp.disabled = !!disabled;
    inp.title = "Override value";
    inp.addEventListener("change", function () {
      onChange({ value: coerceByKind(inp.value, entry._kind || flagKind(flag)) });
    });
    return inp;
  }

  // Shared override row for the Groups & Domains tabs — same layout and feel as
  // the Flags tab: [left toggle] [name] [value control] [×?]. opts:
  //   flag, entry, leftChecked, leftTitle, onLeft(checked),
  //   valueDisabled, onValue(patch), onRemove? — omit onRemove when the left
  //   toggle is itself the removal (group membership model).
  function buildManagedFlagRow(opts) {
    var flag = opts.flag;
    var row = document.createElement("div");
    row.className = "flag-row" + (opts.leftChecked ? " overriding" : "");

    var left = document.createElement("input");
    left.type = "checkbox";
    left.className = "toggle ov-toggle";
    left.checked = opts.leftChecked;
    left.title = opts.leftTitle || "";
    left.addEventListener("change", function () { opts.onLeft(left.checked); });
    row.appendChild(left);

    var lbl = document.createElement("div");
    lbl.className = "flag-label";
    var nameEl = document.createElement("span");
    nameEl.className = "fname";
    nameEl.textContent = (flag.name && flag.name !== flag.key) ? flag.name : flag.key;
    lbl.appendChild(nameEl);
    if (flag.name && flag.name !== flag.key) {
      var keyEl = document.createElement("span");
      keyEl.className = "fkey";
      keyEl.textContent = flag.key;
      lbl.appendChild(keyEl);
    }
    row.appendChild(lbl);

    var ctrls = document.createElement("div");
    ctrls.className = "flag-controls";
    ctrls.appendChild(buildValueControl(flag, opts.entry, opts.valueDisabled, opts.onValue));
    if (opts.onRemove) {
      var x = document.createElement("button");
      x.className = "row-x";
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", opts.onRemove);
      ctrls.appendChild(x);
    }
    row.appendChild(ctrls);
    return row;
  }

  function renderFlags() {
    els.flags.innerHTML = "";
    var list     = displayedFlags();
    var q        = flagFilter.trim().toLowerCase();
    var filtered = list.filter(function (f) {
      if (!q) return true;
      return (f.key  && f.key.toLowerCase().indexOf(q)  >= 0) ||
             (f.name && f.name.toLowerCase().indexOf(q) >= 0);
    });
    var shown = sortFlags(filtered);

    if (!shown.length) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = q ? "No flags match “" + flagFilter + "”." : "No flags.";
      els.flags.appendChild(empty);
      return;
    }

    shown.forEach(function (flag) {
      els.flags.appendChild(buildFlagRow(flag));
    });
  }

  function renderOverrideSummary() {
    var keys = Object.keys(rich.globalOverrides).filter(function (k) {
      return rich.globalOverrides[k] && rich.globalOverrides[k].enabled === true;
    });
    var n = keys.length;
    els.overrideSummary.textContent =
      n === 0 ? "No active overrides." : n + " active override" + (n === 1 ? "" : "s") + ".";
    els.countFlags.textContent = String(n);
  }

  // =========================================================================
  // MANUAL ADD-FLAG (simplified — no type selection; type goes to Settings)
  // =========================================================================
  function populateDiscoveredKeys() {
    els.discoveredKeys.innerHTML = "";
    Object.keys(discoveredFlags).forEach(function (key) {
      var opt = document.createElement("option");
      opt.value = key;
      els.discoveredKeys.appendChild(opt);
    });
  }

  function addManualFlag() {
    var key = (els.manualKey.value || "").trim();
    if (!key) {
      setStatus(els.manualStatus, "Flag key is required.", "err");
      els.manualKey.focus();
      return;
    }
    // Determine kind: use discovered info if available, else default to boolean.
    var disc = discoveredFlags[key];
    var kind = (disc && disc.kind) || "boolean";

    var entry = { enabled: true, _kind: kind };
    if (kind === "boolean") {
      entry.value = true;
      entry.variation = 0;
    } else if (kind === "number") {
      entry.value = 0;
    } else if (kind === "json") {
      entry.value = null;
    } else {
      entry.value = "";
    }

    rich.globalOverrides[key] = entry;
    saveState().then(function () {
      setStatus(els.manualStatus, "Added “" + key + "”.", "ok");
      els.manualKey.value = "";
      renderAll();
    });
  }

  function setStatus(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  // =========================================================================
  // GROUPS TAB
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
        rich.groups = rich.groups.filter(function (g) { return g.id !== group.id; });
        rich.domains.forEach(function (d) {
          d.groupIds = (d.groupIds || []).filter(function (id) { return id !== group.id; });
        });
        saveState().then(renderAll);
      });

      head.appendChild(enable); head.appendChild(nameInput); head.appendChild(del);
      card.appendChild(head);

      var list = document.createElement("div");
      list.className = "rowlist";
      var keys = Object.keys(group.flags || {});
      if (!keys.length) {
        var none = document.createElement("span");
        none.className = "sub";
        none.textContent = "No flags in this group.";
        list.appendChild(none);
      }
      keys.forEach(function (k) { list.appendChild(buildGroupFlagRow(group, k)); });
      card.appendChild(list);
      card.appendChild(buildAddFlagRow(group));
      els.groups.appendChild(card);
    });
  }

  function buildGroupFlagRow(group, key) {
    var flag  = flagByKey(key) || { key: key, kind: "boolean" };
    var entry = group.flags[key] || { value: defaultValueFor(flag) };
    // Group flags have no per-flag enabled state (the group's own toggle gates
    // them), so the left toggle is membership: every shown row is a member, and
    // turning it off removes the flag from the group.
    return buildManagedFlagRow({
      flag: flag,
      entry: entry,
      leftChecked: true,
      leftTitle: "In this group — click to remove",
      onLeft: function (checked) {
        if (!checked) { delete group.flags[key]; saveState().then(renderGroups); }
      },
      valueDisabled: false,
      onValue: function (patch) {
        var e = group.flags[key] || {};
        e.value = patch.value;
        if (typeof patch.variation === "number") e.variation = patch.variation;
        group.flags[key] = e;
        saveState();
      },
    });
  }

  function buildSearchCombobox(avail, placeholder, onAdd) {
    var row = document.createElement("div");
    row.className = "subrow";
    if (!avail.length) {
      var none = document.createElement("span");
      none.className = "sub";
      none.textContent = "(all flags added)";
      row.appendChild(none);
      return row;
    }
    var wrap = document.createElement("div");
    wrap.className = "combobox-wrap";
    var inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = placeholder || "Search flags…";
    inp.autocomplete = "off";
    var drop = document.createElement("div");
    drop.className = "combobox-dropdown";
    drop.style.display = "none";
    function renderDrop(q) {
      drop.innerHTML = "";
      var lower = (q || "").trim().toLowerCase();
      var matches = avail.filter(function (f) {
        if (!lower) return true;
        return f.key.toLowerCase().indexOf(lower) >= 0 ||
               (f.name && f.name.toLowerCase().indexOf(lower) >= 0);
      });
      if (!matches.length) { drop.style.display = "none"; return; }
      matches.slice(0, 25).forEach(function (f) {
        var opt = document.createElement("div");
        opt.className = "combobox-option";
        opt.textContent = f.name && f.name !== f.key ? f.name + " (" + f.key + ")" : f.key;
        opt.addEventListener("mousedown", function (e) {
          e.preventDefault();
          drop.style.display = "none";
          inp.value = "";
          onAdd(f.key);
        });
        drop.appendChild(opt);
      });
      drop.style.display = "block";
    }
    inp.addEventListener("input", function () { renderDrop(inp.value); });
    inp.addEventListener("focus", function () { renderDrop(inp.value); });
    inp.addEventListener("blur", function () {
      setTimeout(function () { drop.style.display = "none"; }, 150);
    });
    wrap.appendChild(inp);
    wrap.appendChild(drop);
    row.appendChild(wrap);
    return row;
  }

  function buildAddFlagRow(group) {
    var avail = activeFlags().filter(function (f) {
      return f.clientSideAvailable !== false && !(group.flags && group.flags[f.key]);
    });
    return buildSearchCombobox(avail, "Add flag…", function (key) {
      var flag  = flagByKey(key);
      var entry = { value: defaultValueFor(flag) };
      if (flag && flag.kind === "boolean") entry.variation = boolVariation(false);
      group.flags[key] = entry;
      saveState().then(renderGroups);
    });
  }

  // =========================================================================
  // DOMAINS TAB
  // =========================================================================
  function addDomain() {
    var pattern = (els.domainPattern.value || "").trim().toLowerCase();
    if (!pattern) { els.domainPattern.focus(); return; }
    rich.domains.push({
      id: uuid(), name: pattern, pattern: pattern,
      matchType: els.domainMatchType.value || "suffix",
      enabled: true, groupIds: [], overrides: {},
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
      domain.groupIds  = domain.groupIds  || [];
      domain.overrides = domain.overrides || {};

      var card = document.createElement("div");
      card.className = "card" + (domain.enabled ? " on" : "");

      var head = document.createElement("div");
      head.className = "card-head";

      var enable = document.createElement("input");
      enable.type = "checkbox"; enable.checked = !!domain.enabled; enable.title = "Enable this profile";
      enable.addEventListener("change", function () { domain.enabled = enable.checked; saveState().then(renderAll); });

      var pat = document.createElement("input");
      pat.type = "text"; pat.value = domain.pattern || "";
      pat.addEventListener("change", function () {
        domain.pattern = (pat.value || "").trim().toLowerCase();
        domain.name    = domain.pattern;
        saveState().then(renderDomains);
      });

      var mt = document.createElement("select");
      [["suffix", "suffix"], ["exact", "exact"], ["glob", "glob"]].forEach(function (p) {
        var o = document.createElement("option");
        o.value = p[0]; o.textContent = p[1]; mt.appendChild(o);
      });
      mt.value = domain.matchType || "suffix";
      mt.addEventListener("change", function () { domain.matchType = mt.value; saveState().then(renderDomains); });

      var del = document.createElement("button");
      del.className = "danger small"; del.textContent = "Delete";
      del.addEventListener("click", function () {
        rich.domains = rich.domains.filter(function (d) { return d.id !== domain.id; });
        saveState().then(renderAll);
      });

      head.appendChild(enable); head.appendChild(pat); head.appendChild(mt); head.appendChild(del);
      card.appendChild(head);

      var hint = document.createElement("p");
      hint.className = "help";
      hint.textContent =
        domain.matchType === "suffix"  ? "Matches " + (domain.pattern || "…") + " and all subdomains." :
        domain.matchType === "exact"   ? "Matches exactly " + (domain.pattern || "…") + "." :
        "Glob match (use * as wildcard).";
      card.appendChild(hint);

      if (rich.groups.length) {
        var gt = document.createElement("div");
        gt.className = "grouptoggles";
        var gtLabel = document.createElement("div");
        gtLabel.className = "sub"; gtLabel.textContent = "Activate groups on this domain:";
        gt.appendChild(gtLabel);
        rich.groups.forEach(function (g) {
          var lbl = document.createElement("label");
          var cb  = document.createElement("input");
          cb.type = "checkbox"; cb.checked = domain.groupIds.indexOf(g.id) >= 0;
          cb.addEventListener("change", function () {
            if (cb.checked) {
              if (domain.groupIds.indexOf(g.id) < 0) domain.groupIds.push(g.id);
            } else {
              domain.groupIds = domain.groupIds.filter(function (id) { return id !== g.id; });
            }
            saveState().then(renderDomains);
          });
          lbl.appendChild(cb); lbl.appendChild(document.createTextNode(g.name || "Untitled group"));
          gt.appendChild(lbl);
        });
        card.appendChild(gt);
      }

      var list = document.createElement("div");
      list.className = "rowlist";
      var ovLabel = document.createElement("div");
      ovLabel.className = "sub"; ovLabel.textContent = "Domain-specific overrides:";
      list.appendChild(ovLabel);
      Object.keys(domain.overrides).forEach(function (k) {
        list.appendChild(buildDomainOverrideRow(domain, k));
      });
      card.appendChild(list);
      card.appendChild(buildAddDomainOverrideRow(domain));
      els.domains.appendChild(card);
    });
  }

  function buildDomainOverrideRow(domain, key) {
    var flag    = flagByKey(key) || { key: key, kind: "boolean" };
    var entry   = domain.overrides[key] || { value: defaultValueFor(flag) };
    var enabled = entry.enabled === true;
    // Domain overrides keep a per-flag pause state: the left toggle pauses /
    // resumes (value preserved, greyed while paused); × removes entirely.
    return buildManagedFlagRow({
      flag: flag,
      entry: entry,
      leftChecked: enabled,
      leftTitle: enabled ? "Active on this domain — click to pause"
                         : "Paused — click to activate",
      onLeft: function (checked) {
        domain.overrides[key].enabled = checked;
        saveState().then(renderDomains);
      },
      valueDisabled: !enabled,
      onValue: function (patch) {
        var e = domain.overrides[key] || { enabled: true };
        e.value = patch.value;
        if (typeof patch.variation === "number") e.variation = patch.variation;
        domain.overrides[key] = e;
        saveState();
      },
      onRemove: function () {
        delete domain.overrides[key];
        saveState().then(renderDomains);
      },
    });
  }

  function buildAddDomainOverrideRow(domain) {
    var avail = activeFlags().filter(function (f) {
      return f.clientSideAvailable !== false && !domain.overrides[f.key];
    });
    return buildSearchCombobox(avail, "Add override…", function (key) {
      var flag  = flagByKey(key);
      var entry = { value: defaultValueFor(flag), enabled: true };
      if (flag && flag.kind === "boolean") entry.variation = boolVariation(false);
      domain.overrides[key] = entry;
      saveState().then(renderDomains);
    });
  }

  // =========================================================================
  // Render orchestration + tabs
  // =========================================================================
  function renderAll() {
    renderFlags();
    renderOverrideSummary();
    renderGroups();
    renderDomains();
  }

  function activateTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "panel-" + name);
    });
  }

  // ---- wire up events -------------------------------------------------------
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () { activateTab(t.dataset.tab); });
  });

  function openSettings() {
    // Delegate to the background script so it survives the popup closing.
    chrome.runtime.sendMessage({ type: "ui:openSettings" });
  }
  els.settingsBtn.addEventListener("click", openSettings);
  if (els.gotoSettings) {
    els.gotoSettings.addEventListener("click", openSettings);
  }

  // Reload the active tab so the user need not reach for the browser's reload.
  // tabs.reload() with no id targets the active tab of the current window and
  // needs no extra permission in either Chrome or Firefox.
  function reloadActiveTab() {
    try {
      if (chrome.tabs && chrome.tabs.reload) chrome.tabs.reload();
    } catch (e) {}
  }
  els.refreshBtn.addEventListener("click", reloadActiveTab);

  // Dock the UI as an always-on sidebar. Chrome uses the right-side Side Panel;
  // Firefox uses its native sidebar (which the browser docks on the left).
  function dockAsSidebar() {
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.windows.getCurrent().then(function (win) {
          chrome.sidePanel.open({ windowId: win.id })
            .then(function () { window.close(); })
            .catch(function () {});
        });
        return;
      }
    } catch (e) {}
    try {
      var sb = (typeof browser !== "undefined" && browser.sidebarAction) ||
               (typeof chrome !== "undefined" && chrome.sidebarAction);
      if (sb && sb.open) {
        sb.open();
        window.close();
      }
    } catch (e) {}
  }
  els.dockBtn.addEventListener("click", dockAsSidebar);

  // Panel context: fill the docked pane and hide the (now-redundant) dock
  // button. Also hide it in a popup that has no sidebar capability at all.
  var canDock = !!(chrome.sidePanel && chrome.sidePanel.open) ||
    !!((typeof browser !== "undefined" && browser.sidebarAction) ||
       (typeof chrome !== "undefined" && chrome.sidebarAction));
  if (isPanel) document.body.classList.add("ctx-panel");
  if (isPanel || !canDock) els.dockBtn.style.display = "none";

  els.flagSearch.addEventListener("input", function () {
    flagFilter = els.flagSearch.value;
    renderFlags();
  });

  els.flagSort.addEventListener("change", function () {
    sortField = els.flagSort.value;
    renderFlags();
  });

  els.flagSortDir.addEventListener("click", function () {
    sortAsc = !sortAsc;
    els.flagSortDir.textContent = sortAsc ? "↑" : "↓";
    renderFlags();
  });

  els.showServerSide.addEventListener("change", function () {
    showServerSide = els.showServerSide.checked;
    updateSourceNote();
    renderFlags();
  });

  els.manualAddBtn.addEventListener("click", addManualFlag);
  els.manualKey.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addManualFlag();
  });

  els.groupAdd.addEventListener("click", addGroup);
  els.groupName.addEventListener("keydown", function (e) { if (e.key === "Enter") addGroup(); });

  els.domainAdd.addEventListener("click", addDomain);
  els.domainPattern.addEventListener("keydown", function (e) { if (e.key === "Enter") addDomain(); });

  els.clear.addEventListener("click", function () {
    rich = { version: 1, globalOverrides: {}, groups: [], domains: [] };
    saveState().then(renderAll);
  });

  // ---- init -----------------------------------------------------------------
  // Adopt a freshly-read storage snapshot into in-memory state and re-render.
  function hydrate(res) {
    rich = State
      ? State.migrate(res)
      : { version: 1, globalOverrides: res["flagswap:overrides"] || {}, groups: [], domains: [] };
    rich.version = 1;
    rich.globalOverrides = rich.globalOverrides || {};
    rich.groups  = rich.groups  || [];
    rich.domains = rich.domains || [];
    discoveredFlags = res[K_DISC] || {};

    populateDiscoveredKeys();
    updateSourceNote();
    renderAll();
  }

  // Re-read storage and refresh the view. Used by the panel/sidebar live-sync
  // listener so an always-on sidebar reflects changes made elsewhere (other
  // tabs editing, domain auto-switching, a re-sync from Settings). We skip the
  // refresh while the user is mid-edit so a remote change can't blow away focus.
  function liveSync() {
    var ae = document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    get([K_STATE, "flagswap:overrides", K_SEL, K_DISC]).then(function (res) {
      hydrate(res);
      return loadCachedFlags(res[K_SEL] || {});
    });
  }

  function init() {
    return get([K_STATE, "flagswap:overrides", K_TOKEN, K_SEL, K_DISC]).then(function (res) {
      hydrate(res);
      var selection = res[K_SEL] || {};

      // One-time migration: persist legacy data under new key. Runs ONLY here,
      // never on a live-sync refresh.
      var hadState  = res[K_STATE]             && typeof res[K_STATE]             === "object";
      var hadLegacy = res["flagswap:overrides"] && typeof res["flagswap:overrides"] === "object";
      var promise = (!hadState && hadLegacy) ? saveState() : Promise.resolve();

      return promise.then(function () {
        return loadCachedFlags(selection);
      });
    });
  }

  // Keep a docked sidebar in sync with external storage changes (popup is
  // short-lived and re-reads on open, so it doesn't need this).
  if (isPanel && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      for (var k in changes) {
        if (k === K_STATE || k === K_DISC || k === K_SEL ||
            k.indexOf("flagswap:flagCache:") === 0) {
          liveSync();
          return;
        }
      }
    });
  }

  init();
})();
