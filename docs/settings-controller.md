# Settings UI integration contract

`extensions/codebase-router.ts` is the single entry point. It calls
`registerCodebaseRouter` once, registering commands/events and returning a live
`RouterController`, then registers `/cbrouter-settings` on that same controller.
Do not register a second controller for a UI.

```ts
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodebaseRouter } from "../src/controller.js";
import { openRouterSettings, registerSettingsCommand } from "../src/settings-ui.js";

export default function (pi: ExtensionAPI) {
  const controller = registerCodebaseRouter(pi, {
    agentDir: getAgentDir(),
    projectConfigDir: CONFIG_DIR_NAME,
    openSettings: openRouterSettings,
  });
  registerSettingsCommand(pi, controller);
}
```

`openSettings(controller, ctx, scope?): Promise<void>` is called by `/cbrouter`
with no arguments and by `/cbrouter settings|config [global|local]`, including
while off. Without a handler, the bare command displays status. Non-UI commands
remain available independently.

## Shipped settings UI (`src/settings-ui.ts`, `src/settings-model.ts`)

- `ctx.mode === "tui"`: an inline `ctx.ui.custom()` screen
  (`RouterSettingsComponent`) with `blocked: { kind: "question", message:
  "Router settings" }`. It uses only the injected theme, `tui.requestRender()`,
  `tui.terminal.rows` and the injected `KeybindingsManager` (`tui.select.*`,
  `tui.input.tab`, `tui.input.submit`), sets `capturesViewportInput`, propagates
  focus to its `Input`, bounds every line to the supplied width, and compacts to
  `rows - 4` lines. It closes only through `done()`.
- `ctx.mode === "rpc"` (`hasUI` true): `runDialogSettings` loops over native
  `select`/`input`/`confirm` dialogs with the same choices.
- No UI (`print`/`json`): throws an actionable message naming the textual
  `/cbrouter` commands and both file paths; Pi reports it as a command error.

Editors are scope-specific: rows show `fieldView()` layer values; unset keys show
the lower layer they inherit from. **Inherit** sends `{ key: null }` for the
selected file only; reset sends nulls for that file's saved keys. Each choice
calls `controller.save`/`clearSession` immediately. Cancel/back never writes.
Thrown errors are displayed and the text draft remains in the editor.
`src/settings-model.ts` is rendering metadata/formatting only; validation,
precedence, trust and persistence remain in the controller/config layer
(`parseTextField` only pre-checks text input for friendlier messages).

## Controller API

All methods are synchronous; persistence errors **throw**. Catch them, display an
error, and keep the draft instead of claiming success. Methods that mutate
settings refresh footer status and cancel router-owned indexing immediately if
the resulting effective mode is off. No reload is required.

- `snapshot(ctx): RouterSnapshot`: fresh resolved files/environment/session data.
- `setSession(ctx, patch)`: validate/merge session overrides and append a custom
  session entry before publishing the change. Survives reload/resume of the same
  session ID. Forked sessions do not inherit another session's override.
- `clearSession(ctx, keys?)`: remove selected session keys (all by default).
- `save(ctx, "global" | "local", patch)`: merge into the latest file, validate,
  preserve unknown keys, write a same-directory temporary file, fsync, and rename
  atomically. It does **not** clear higher-priority session/environment overrides.
- `reload(ctx)`: re-inspect Git worktree state and refresh settings/status. Ordinary
  snapshots already re-read config files; this is not Pi's runtime `/reload`.

`ConfigPatch` has the known `RouterConfig` keys with their typed values; `null`
removes a key from that layer. Do not pass `undefined`, unknown keys, blank
`indexBin`, fractional/nonpositive timeout values, or out-of-range modes. The
maximum timeout is 2,147,483,647 ms (Node's timer range). The core rejects these.
To reset persistent settings, send explicit nulls for the desired keys. A
malformed/non-object file cannot be overwritten by Save; the user must repair it.
A known invalid setting must be repaired/removed before saving unrelated keys.

## Snapshot fields for rendering

- `values`: configured effective values, with precedence
  **session > env > local > global > default**.
- `sources`: a source for every config key (including unset `indexBin`: default).
- `layers.global/local`: `path`, validated `values`, optional `error`/`ignored`.
  Use these layer values to populate scope-specific editors rather than writing
  inherited effective values into the selected file accidentally.
- `layers.env/session`: the explicit overrides; offer clearing session overrides.
  Environment overrides cannot be cleared by editing JSON; explain shadowing.
- `effectiveMode`: runtime mode after linked-worktree bypass. This can be off
  while `values.mode` remains enforce/warn. `linkedWorktree` explains why.
- `available`, `readiness` (`unknown`/`ready`/`degraded`), `issue`: tool availability
  and observed index readiness, **not** a guarantee of index freshness.
- `indexing`, `pendingMutation`, `queuedTurn`, `turnMayStillRun`: lifecycle state.
  Pi cannot retract an already queued opt-in agent follow-up. The commands warn
  when one may remain after off; a UI should display the same caveat when true.
- `counters`: `blocked`, `indexedCalls`, `context`, `editContext`, `architecture`.

## Trust and scope constraints

`ctx.isProjectTrusted()` (Pi 1.5) is authoritative. The entire local config is
ignored when false, and local saves throw before creating directories/files.
Session changes and global saves remain accessible, particularly session off.
Untrusted project-local CLI auto-discovery is also disabled. Never implement a
trust prompt or mark the project trusted on the router's behalf.

`worktreeMode` is `off` (default) or `inherit`. `inherit` opts the current linked
worktree into the configured router mode; it does not share main-checkout
retrieval evidence or widen the indexed cwd. The router never manages the
companion extension's independent watcher.

## Latest Pi 1.5 UI requirements

See [the compatibility audit](pi-compatibility.md) before implementation. Target
coding-agent/pi-tui 1.5.0 and Node >=22.19.0. Use the injected custom-component
keybindings manager (not a global singleton), including remapped selection and
pageUp/pageDown actions. Forward `capturesViewportInput` from SettingsList or
implement it for a custom viewport so paging is not consumed by the fullscreen
transcript. Guard custom components with `ctx.mode === "tui"`; `ctx.hasUI` alone
also includes RPC. Preserve textual command access and visible errors outside
TUI. An inline screen waiting for an answer should use custom()'s
`blocked: { kind: "question", message: "Router settings" }`; overlays ignore this
option. Respect supplied dimensions/themes/focus, invalidate and request renders,
and close through done(). Test modes, remapped keys/paging, narrow/resize cases,
cancel and save failures. The core owns only `sections.codebase_router` in the
modern structured prompt API; the UI must not replace the whole system prompt.

## Test seam

`RouterOptions.env` provides an isolated environment for tests; production omits
it. `agentDir` and `projectConfigDir` come from Pi, not hardcoded live-user paths.
Tests mock `ExtensionAPI` events/commands and contexts and run an isolated MCP
fixture. The UI should reuse `test/harness.ts` where useful and add its own
mode/keybinding/save-failure tests without modifying live settings.
