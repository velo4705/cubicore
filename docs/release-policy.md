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

## Current state (2026-11-22)

| Tag | Version | Status |
| --- | --- | --- |
| `latest` | 1.1.19 | Founder verified end-to-end on the daily host: two-phase dispatch, compact roster, preview manual steps, demo/full mode policy. |
| `beta` | 1.1.18 | Older, superseded pre-release. |

No speed, cost, or quality claim may be attached to either tag until the Phase 5
benchmark is actually run. Efficiency is a demo-mode concern; Full Product is
judged on engineering quality, not time.
