# Cubicore plan

## What this is

Packed-artifact publish check: two disjoint one-file markers.

- **Topology:** fan-out
- **Project size:** small (2 associates)
- **Token ceiling:** 12,000
- **Wall ceiling:** 240s
- **Validation:** passed

## Why this factory?

- Decision: small-factory (team of 2)
- Why: a few genuinely independent slices — parallel work pays
- Why not more: any extra worker adds coordination with nothing to parallelise against
- Confidence: high

## Associates

### ✅ marker-a

Create smoke-factory/a.txt containing exactly the line alpha

- **Writes:** smoke-factory/a.txt
- **Reads:** (none)
- **Deliverable:** diff
- **Done when:** smoke-factory/a.txt exists and contains the line alpha
- **Checks:**
  - `test -f smoke-factory/a.txt && grep -qx alpha smoke-factory/a.txt` (blocking, convergent)

### ✅ marker-b

Create smoke-factory/b.txt containing exactly the line beta

- **Writes:** smoke-factory/b.txt
- **Reads:** (none)
- **Deliverable:** diff
- **Done when:** smoke-factory/b.txt exists and contains the line beta
- **Checks:**
  - `test -f smoke-factory/b.txt && grep -qx beta smoke-factory/b.txt` (blocking, convergent)

## Machine-readable

The dispatchable plan is `CUBICORE_PLAN.json`. Execute reads that file, never this one.
