# Release policy

Effective 2026-11-21, by founder decision:

- **`latest` is the version that works perfectly.** It is moved only after the
  build has been verified end-to-end on the daily host.
- **Everything else is published as `beta` (pre-release)** — never as `latest`.

## Commands

Publish an unverified build without touching `latest`:

```sh
npm publish --tag beta
```

Promote a verified build to `latest`:

```sh
npm dist-tag add cubicore@<version> latest
```

Keep the previous release reachable by its own tag if it still matters:

```sh
npm dist-tag add cubicore@<version> beta
```

Verify the actual tags (not just `npm view cubicore version`, which reflects
`latest`):

```sh
npm dist-tag ls cubicore
```

## Current state (2026-11-21)

| Tag | Version | Status |
| --- | --- | --- |
| `latest` | 1.1.16 | Founder-designated known-good. Still carries the stale `dispatch_blueprint` hand-dispatch note. |
| `beta` | 1.1.17 | Removes that stale instruction; not yet verified on the daily host. |

Do not promote 1.1.17 to `latest` until a live run confirms it. The next build replaces the stage-gated dispatch with two-phase dispatch (all builder sessions up front, integration/smoke last); it is also unverified and must ship as beta until a live run confirms it. No speed, cost,
or quality claim may be attached to either tag until the Phase 5 benchmark is
actually run.
