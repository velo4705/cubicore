# Milestone

## Landscape: inline sub-tasks vs sessions

Surveyed across the coding agents Cubicore could plausibly target.

| Agent | Inline sub-tasks | Sessions / worktrees | Primary interface |
|---|---|---|---|
| Claude Code | ✅ | ✅ | Terminal CLI; transient sub-agents, native git isolation, MCP |
| OpenAI Codex | ✅ | ✅ | Terminal / API; sandboxed cloud, ephemeral session ids |
| Cursor | ❌ | ✅ | AI-native IDE; parallel editor states, cloud sessions, MCP |
| Windsurf | ✅ | ✅ | AI IDE (Cascade); sub-agent tracking, git worktrees, MCP |
| Devin | ❌ | ✅ | Autonomous; isolated containerised VMs, async tickets |
| Replit Agent | ❌ | ✅ | Cloud IDE; persistent multiplayer workspaces |
| Cline / Roo Code | ❌ | ✅ | VS Code extension; one persistent session, external plugins, MCP |
| Aider | ❌ | ✅ | Git-first CLI; commits as sessions |
| OpenCode | ✅ | ✅ | Open-source TUI; task delegation and modular session workspaces |

**Sessions: 9 of 9. Inline sub-tasks: 4 of 9.**

That asymmetry drives the priority order.

## Priority 1 — inline sub-tasks

Available in Claude Code, Codex, Windsurf and opencode: the four agents most
worth targeting, and the ones whose users expect to watch work happen.

Why it leads:

- **Immediacy.** A 366-second opaque tool call is indistinguishable from a
  hang. Observed repeatedly in live runs — work landed, nothing returned.
- **It is the host's own affordance.** We would render through a mechanism
  users already understand rather than one Cubicore invents.
- **It aligns with D7.** Aggregators read artifacts, not transcripts. The
  transcripts were never the point; defending sessions as an audit trail
  contradicted a decision already made.

## Priority 2 — sessions

Universal (9 of 9), so this is the portable primitive and the portability
story. Retained because it provides what inline cannot:

- post-hoc inspection of what an associate actually did
- independent cancellation and per-contract wall-clock tracking
- a durable record across process restarts

Sessions are what opencode's platform shape pushed us toward initially, and
they work. They are the fallback, not the destination.

## Both

The four leading agents support both. They are complementary, not competing:

| Need | Mechanism |
|---|---|
| See work as it happens | Inline sub-task |
| Audit afterwards | Session |
| Cancel one associate | Session |
| Enforce disjoint writes | Either |
| Gate the result | Either |

Cubicore's contract layer, gates, budgets and refusal logic sit above both and
are unaffected by the choice.

## What this does not change

The enforcement layer is portable either way: validation, the check matrix,
gating, budget caps, topology. Only orchestration moves.

**Open question carried forward:** under inline dispatch, `settledUsage` has no
associate session rows to read, so the cost claim loses its current source.
That must be resolved before the orchestrated benchmark arm can report X and Y.

## Known state

- Plugin and MCP front-ends both dispatch, gate and report a verdict
- `execute` returns a run handle; `status` polls — timeouts no longer lose a verdict
- Disjoint writes verified by digest on a real four-associate run
- Executable checks caught two defective planner fixtures
- Corpus plans for the benchmark do not exist yet; X and Y are unmeasured