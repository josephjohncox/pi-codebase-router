# Pi compatibility audit

Target: **Pi coding-agent 1.5.0 and pi-tui 1.5.0, Node >=22.19.0**. Both were
verified as the latest stable npm releases for this audit; their installed
package manifests independently declare the same Node minimum. This is a router
compatibility audit, not a claim that older Pi releases were runtime-tested.

Read the complete 1.5.0, 1.4.0, 1.2.0, and 1.0.0 entries in Pi's
[CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md),
plus the current extensions, session-format, packages, and TUI documentation and
relevant complete prompt-customizer/tools/state/trust examples.

## Compatibility matrix

| Pi change/API | Router response | Evidence / ownership |
| --- | --- | --- |
| Structured `before_agent_start.systemPromptOptions` | Mutates only `sections.codebase_router`; never returns a complete systemPrompt override. Preserves other sections, guidelines, user prefixes and explicit overrides; removes its section when inactive. Lets Pi emit section deltas rather than forcing a whole-prefix replacement. | `test/pi-compatibility.test.ts`, `test/controller.test.ts`; current prompt-customizer example. |
| 1.2: `messageType: user\|custom`; custom starts have no prompt | Only user code prompts receive guidance. Custom-message/non-code starts remove stale router sections without accessing a missing prompt. | `test/pi-compatibility.test.ts`. |
| Nested codemode tool calls carry `parentToolCallId`; child IDs are `<parent>/<n>` | Tracks each child toolCallId independently, including out-of-order completion; no dependence on transcript entries for nested calls. | Typed current `ToolCallEvent`, `ToolResultEvent`, `ToolExecutionEndEvent` fixtures in `test/pi-compatibility.test.ts`. |
| `tool_result` has input/content/isError; final `tool_execution_end` has result/isError but no args | Captures mutable input at tool_call, then observes finalized execution-end results. Does not expect event.args or mistake the tool_result payload for execution_end. Failed/outside children do not dirty. | `test/pi-compatibility.test.ts`, `test/controller.test.ts`; native Pi status details and text-only MCP status both covered. |
| Final `agent_settled` versus low-level `agent_end`; 1.1 adds settled.aborted | Indexing waits for settled, not an intermediate end/retry. A successful scoped write remains real if the surrounding run later aborts. | `test/pi-compatibility.test.ts`, `test/background.test.ts`. |
| Session replacement on reload/new/resume/fork; `/tree` changes active branch | Shutdown cancels owned work; same-session overrides restore from getBranch + appendEntry. Forks do not inherit another session ID's override. | `test/config.test.ts`, `test/controller.test.ts`, `test/background.test.ts`. |
| 1.4: resumed/tree tool restoration and queued codemode workers | Checks current callable tools, including codemode/deferred exposure, rather than assuming all registered tools are active or relying on synchronous nested completion. | `test/controller.test.ts`, nested lifecycle test. |
| 1.5: saved distrust correctly reaches `ctx.isProjectTrusted()` | Uses current session trust API directly; ignores entire untrusted local config and rejects local saves/CLI discovery while keeping session/global controls. Never consults/replaces a private trust store. | `test/config.test.ts`, `test/background.test.ts`. |
| 1.5: pi-schema argument coercion replaces TypeBox-specific validation | Router registers no LLM tool schemas and relies on no TypeBox refinements. Its own config validation remains explicit and rejects invalid saved values. Final host isError is authoritative. | `test/config.test.ts`; typed finalized-event tests. |
| 1.0: fullscreen default; 1.4/1.5 dialog, viewport paging, injected hints and custom blocked reporting | Settings screen is inline `custom()` only when `ctx.mode === "tui"`, with `blocked` question status, injected keybindings (remapped select/page/tab/submit), `capturesViewportInput`, focus propagation, width/height bounds and `done()`. RPC uses native dialogs; print/JSON throw actionable usage. | `test/settings-ui.test.ts`; `docs/settings-controller.md`. Real Pi 1.5 fullscreen/regular TUI and RPC smoke recorded in the UI handoff, not CI. |
| 1.5: extension package update changelog display | Ships root CHANGELOG.md, Pi's default path. Package version must have a matching release heading. Release 0.4.0 has a matching version heading. | Package/changelog regression in `test/pi-compatibility.test.ts`; pack dry-run; parent-owned release gate. |

Provider/model/catalog updates in these Pi releases do not change router
behavior. The router does not manage model selection, authentication, provider
payloads, MCP registration, or Pi's worker pool.

## Required UI handoff: current 1.5 APIs

- Call the existing single-controller `openSettings(controller, ctx)` hook. Do
  not duplicate controller state, persistence, precedence or trust decisions.
- Guard custom components with `ctx.mode === "tui"`. `ctx.hasUI` also includes
  RPC; RPC custom components do not provide a functioning TUI. Preserve usable
  textual commands/fallback in RPC/JSON/print modes and do not swallow save errors.
- Use injected `(tui, theme, keybindings, done)` from `ctx.ui.custom`. Match
  configurable actions with that keybindings manager, including
  `tui.select.up/down/confirm/cancel/pageUp/pageDown`. Avoid a separate global
  keybinding singleton; renderer hints use injected keyText/keyHint when relevant.
- Forward `capturesViewportInput` from an owned SettingsList (or implement it on
  the custom paging component), so PageUp/PageDown go to the settings viewport
  rather than the fullscreen transcript. Test remapped paging keys.
- For an **inline** screen waiting for an answer, pass
  `blocked: { kind: "question", message: "Router settings" }` to custom().
  Overlays ignore blocked; do not claim it reports overlay wait state.
- Bound rendering to supplied width/height; use Pi width utilities, invalidate
  caches after edits/theme/resize, requestRender, and finish through done().
  Forward focus into Input/Editor children. Test both regular and fullscreen
  behavior, narrow widths, cancel, modes, remapped bindings and failed saves.
- Pi supplies pi-tui at runtime. If the UI imports it, declare it as a
  host-provided peer, not a bundled/runtime dependency.

## Release and validation boundary

CI covers the declared minimum Node 22.19.0 and Node 24. Local checks in this run
use Node 26. Core tests use mocked ExtensionAPI events plus real Git/MCP fixtures;
they do not prove a real model/provider's cache-hit rate or full TUI rendering.
Release gates include independent review, real Pi loading and TUI/RPC smoke,
version-matched package/changelog metadata, and GitHub Release -> npm OIDC.
`npm test` checks that the current manifest version has a shipped changelog heading.

Readiness regressions also cover successful snippets containing error/migration
text, transient query errors, bounded index diagnostics, and recovery from
text-only MCP status. Nested linked worktrees and symlinked config saves have
real-filesystem regressions in `test/review-regressions.test.ts`.
