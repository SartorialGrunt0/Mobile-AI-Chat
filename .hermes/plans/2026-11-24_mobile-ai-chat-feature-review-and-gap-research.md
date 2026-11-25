# Mobile-AI-Chat — Feature Review + Market Gap Research

Date: 2026-11-24. main @ 456a0a0. Method: full codebase audit (subagent, key claims re-verified by hand) +
web research across 21 products (7 mainstream, 14 self-hosted/open). FOR DISCUSSION — nothing started.

## 1. Feature inventory (as shipped)

| Area | Status | Notes |
|---|---|---|
| Conversation mgmt | partial | create(lazy)/rename/delete/auto-title; NO search, pin, folders, branching. Edit-and-resend = destructive truncate (server.js:484-516) and drops attachments (app.js:3977) |
| Streaming UX | partial | real stop + retry; "resume" = 3s full-chat poll (app.js:5514-5568); no queue — mid-stream sends vanish silently (app.js:1127-1130); stop discards partial answer (server.js:986-1009) |
| Model/provider | partial | 3 providers, per-chat param overrides; model is global state — openChat never restores chat.modelKey (app.js:950-987) and next send overwrites it (chat-repository.js:338-364); no provider id stored per chat |
| Multimodal | partial | image + text-file attach; full-res base64 into SQLite, re-sent every turn; no downscale, paste/drop, camera, vision gating; binary files → stub string |
| Prompts | partial | global + per-chat system prompt, adaptive memory; NO templates/presets/slash commands/library; effective-prompt preview computed but never shown (app.js:2387) |
| Output | partial | hand-rolled markdown + KaTeX + tables; copy per block/message; Markdown-only export; browser speechSynthesis TTS + dictation; NO syntax highlighter loaded |
| MCP | partial | in-app servers, per-chat selection, tool loop (cap 8); whole-server granularity despite "tools" label; no approval step, no resources/prompts |
| Mobile UX | partial | safe-area + dvh + 44px targets + dark toggle done; NO manifest/service worker → not installable; no offline listeners, swipe, haptics, prefers-color-scheme |
| Persistence | partial | shared SQLite on server (good multi-device story); no active-chat persistence across reload; base64 bloat; no JSON backup/restore |
| Security | partial | PBKDF2 600k + HMAC cookie solid; but: 1-char PIN accepted (auth.js:85-97), Lock button permanently hidden (app.js:1461), every reload force-logs-out all tabs (app.js:199-204), no Secure flag/CSRF, secrets plaintext in appsettings.runtime.json |

`origin/add-koroko-support`: server-side Kokoro TTS (+2068, tts-service.js) — coherent but forks from a
pre-refactor main (merge base 94cec9a, 16 commits back; touches deleted mcp-catalog/LmStudio config) →
needs rebase; one global voice, no clip caching (Cache-Control: no-store), no browser-TTS fallback.

## 2. Verified code-level defects (fix candidates, cheap)

1. `sendMessage()` returns silently while streaming (app.js:1127-1130) — typed text vanishes, no feedback.
2. Stop/abort destroys the partial answer (persisted only on finalResponse, server.js:986-1009).
3. Retry/edit delete DB history BEFORE the replacement succeeds (server.js:447, 503) — provider error = lost turns.
4. openChat ignores chat.modelKey; next send silently overwrites the chat's model (app.js:893-895, chat-repository.js:338-364).
5. OpenAI path silently ignores Top K / Min P / Repeat Penalty / Reasoning / Context (provider-client.js:674-687) while the UI accepts them.
6. Lock/logout UX contradiction: hidden button (app.js:1461) + forced logout on every load (app.js:199-204) + no PIN floor (auth.js:85-97).
7. Ghost element ids referenced in app.js, absent from index.html (chat-toolbar, model-tools-section, mcp-list, chat-override-mcp-list).
8. Dead code: duplicate buildLmStudioInput (server.js:1052-1084), parseDataUrl/mergeUsage (provider-client.js:565,660).
9. `npm run check` never checks the 5.6k-line frontend (package.json scripts.check).
10. Connection pill reports auth state, not connectivity (app.js:1462-1463); no online/offline listeners anywhere.

## 3. Market baseline (features nearly every popular app has)

Streaming+stop+regen · chat list w/ rename+delete+SEARCH · markdown w/ syntax-highlighted code+copy ·
file/image upload · edit-and-resend + version-steppable regenerates · voice (≥ dictation+read-aloud) ·
per-chat system prompt · model picker w/ per-chat memory · copy/retry reply actions · shareable link ·
installable app (native, or PWA: Open WebUI, LibreChat, LobeChat) · temporary/incognito chat.

Power-user differentiators (self-hosted benchmarks): first-class branching (llama.cpp WebUI branches on
every edit, nothing lost; LibreChat fork modes) · mid-stream queue/steer (LibreChat benchmark, Open
WebUI queue) · MCP host w/ per-tool auth/approval (LibreChat, LobeChat approve-deny) · named presets
(LM Studio Config Presets, LibreChat prompts w/ {{vars}}+versions) · side-by-side models (Open WebUI,
Msty, Chatbox) · JSON import/export (llama.cpp, Chatbox) · capability-aware input gating (llama.cpp) ·
document extraction (Open WebUI 8 engines, AnythingLLM) · push for finished work (nobody self-hosted does
it — open lane) · transparent telemetry (already an app strength).

## 4. Ranked gaps for Mobile-AI-Chat

### Tier A — baseline misses (every competitor has these)
- **A1 Queue while streaming** — today mid-stream input silently disappears. Minimum: queue as next
  turn (Open WebUI) + visible feedback. (KWC interface research G4 reached the same verdict independently.)
- **A2 Destructive history ops** — stop discards partials; retry/edit delete before success. Fix at the
  persistence layer: persist partials on abort; write-ahead the replacement before deleting.
  Non-destructive version/branch storage enables regen-variants for free (llama.cpp model).
- **A3 Chat search** — list endpoint returns everything, no filter (chat-repository.js:73-102).
  SQLite FTS5 over messages is a day of work.
- **A4 Syntax highlighting + copy-everywhere** — no highlighter loaded; user messages have no copy.
- **A5 Per-chat model/provider binding** — restore on open, stop silent overwrite, store provider id
  per chat so provider switching doesn't reinterpret model keys.
- **A6 PWA installability** — manifest + icons + minimal SW; no competitor in the self-hosted lane
  ships *zero* (Open WebUI/LibreChat/LobeChat all installable; llama.cpp WebUI is the only company —
  and it's the closest analogue).
- **A7 Honesty of the params UI** — either transmit top_k/min_p/repeat_penalty/reasoning on the
  OpenAI path (most servers accept extra body fields) or hide/disable per provider.
- **A8 Auth coherence** — PIN floor, reachable lock (or drop the auto-logout-all-tabs behavior),
  document the LAN/HTTP posture honestly.

### Tier B — parity with the local-LLM frontend lane (ChatterUI, llama.cpp WebUI, LM Studio, AnythingLLM Mobile)
- Named presets (system prompt + params bundles) — biggest single power-user win vs. current
  one-default-per-provider.
- Attachment pipeline: client downscale, paste/drop, camera capture, PDF/DOCX extraction, vision-capability gating.
- Regenerate producing steppable variants (rides on A2's branch storage).
- JSON conversation export/import (markdown-only today; users can't back up history losslessly).
- True stream re-attach after reload (SSE resume from last token) instead of 3s polling — the
  intentional "keep generating after disconnect" design already half-supports this.

### Tier C — differentiators worth choosing among (fit ranked for a self-hosted mobile web app)
1. **MCP per-tool toggles + approval gate for irreversible tools** — matches the house design
   philosophy (gate only irreversible actions); nobody in the mobile-web lane has it.
2. **Push notification when a long generation finishes** — push is the one thing no self-hosted UI
   does; Web Push from a PWA is feasible; pairs with the keep-generating-after-disconnect design.
3. **Branch tree navigation** (llama.cpp-style, nothing ever lost).
4. **Side-by-side / duplicate-chat model comparison** — LM Studio pattern, strong on tablets.
5. **Prompt library with {{variables}}** (LibreChat pattern).
6. Koroko TTS finished properly: rebase onto post-refactor main, per-chat voice, clip caching,
   browser-TTS fallback.

### Explicitly NOT gaps for this product (market has it, fit is wrong)
Artifacts/canvas panes, agent/computer-use, marketplaces, deep-research, group chats — all
desktop/cloud-shaped; none fit a phone-first viewer over the user's own inference server.

## Sources
- Audit: full-trace transcript at ~/.hermes/profiles/coder/cache/delegation/live/deleg_1016b04c/task-0.log
- Market research (21 products, cited): subagent-summary-1-20261124_202713_295556.txt (same dir)
- Key external refs: librechat.ai/docs/features/fork · llama.app/docs/webui ·
  docs.openwebui.com/features · lobehub.com/docs/usage/agent/message-actions ·
  lmstudio.ai/docs/app/presets · github.com/Vali-98/ChatterUI · docs.anythingllm.com/mobile/overview
