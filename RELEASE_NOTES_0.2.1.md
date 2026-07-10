# FlagSwap — Release Notes

## Portal-ready summary (paste into AMO "Release Notes", 0.2.1)

Fixes horizontal scrolling in the popup and sidebar. The Containers tab could
push the tab bar past the window width, clipping part of the UI — especially in
the narrow docked sidebar. Tabs now shrink to fit and wrap to a second row on
narrow panes.

---

## Cumulative "What's new since 0.1.0" (for a first full public listing)

FlagSwap lets QA engineers and developers override LaunchDarkly feature flags
right in the browser — no code, no config changes. Highlights since the first
release:

- **Per-flag on/off overrides** with a name + toggle for every flag; server-side
  flags clearly marked and filterable.
- **Flag groups** — save named sets of flags and their default states, then flip
  a whole group on or off at once.
- **Domain profiles** — different flag combinations per domain / sub-domain; the
  extension switches automatically as you move between sites.
- **Per-container scoping (Firefox Containers)** — two tabs on the same site in
  different containers can resolve to different flag values. Merge mode layers on
  top; Solo mode isolates to just that container's flags.
- **Flag sync from LaunchDarkly** — pull your real flag list and served values in
  via the Flag Sources settings, so overrides use accurate defaults.
- **Always-on sidebar mode** — dock FlagSwap alongside the page instead of using
  the popup, with a per-tab refresh button.
- **Searchable, sortable flag list** with quick filtering.
- Refreshed brand icons and numerous UX and reliability fixes.

---

## Per-version breakdown

### 0.2.1
- Fix: popup and docked sidebar no longer scroll horizontally. The Containers tab
  pushed the tab bar past the pane width (worst in the narrow sidebar); tabs now
  shrink and wrap instead of overflowing.

### 0.2.0
- New: **Container scoping** — per-Firefox-container flag overrides with merge /
  solo modes (Containers tab).
- New: **Flag Sources** settings with a LaunchDarkly sync-state signal.
- Refreshed brand icons (transparent background, larger mark).
- Build: per-browser distribution packaging.
- Fix: card-head select sizing in the popup.

### 0.1.2
- Added the Swap Loop brand icon and popup header mark.

### 0.1.1
- Redesigned popup UX: name + toggle per flag; setup moved to a dedicated
  Settings page.
- Flag list improvements: sort, server-side (SS) filter, default-status display,
  searchable combobox for adding overrides.
- Added **always-on sidebar mode** and a per-tab refresh button.
- Flag defaults now resolve to LaunchDarkly's actual *served* value.
- Override rows reworked to be consistent across the Flags / Groups / Domains tabs.
- Fix: overrides now reliably reach the page on Firefox (cross-compartment event
  delivery).
- Fix: override toggle was a no-op for non-boolean flags.
- Manifest tidied for AMO; minimum Firefox raised to 140.

### 0.1.0
- Initial release: MV3 extension that overrides LaunchDarkly feature flags on/off
  from the browser.

---

## Technical detail — 0.2.1 (not for the portal)

- `src/popup.css`: `body { overflow-x: hidden }`; `.tabs { flex-wrap: wrap }`;
  `.tab { flex: 1 1 auto; min-width: 0 }`; `.tab .lbl` ellipsis truncates the
  label, not the count badge.
- `src/popup.html`: each tab label wrapped in `<span class="lbl">`.
- No permission, API, or data-model changes. Firefox linter: 0 errors
  (4 pre-existing warnings — Chrome-only `sidePanel` guarded at runtime, Android
  min-version notice).

Upload artifact: `dist/packages/flagswap-0.2.1-firefox.zip`
