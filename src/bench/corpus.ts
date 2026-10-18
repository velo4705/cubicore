import type { PlanShape, TaskSpec } from "./types";

/**
 * The benchmark corpus.
 *
 * Every task here is **genuinely decomposable** — disjoint files, no shared
 * interface — because that is the premise under test. A corpus containing
 * interface changes or cross-cutting refactors would measure the wrong thing:
 * Cubicore is designed to *refuse* those, so they belong in a refusal corpus
 * rather than a speed one.
 *
 * Tasks are also sized so real work dominates the ~36K-token session prefix. A
 * trivial task measures the bootstrap floor for all three arms and the
 * orchestration difference disappears into noise.
 *
 * `expectedWorkers` is what the naive-fanout control is sized by. It has to
 * match what an orchestrator would plausibly choose, or the comparison is not
 * like-for-like.
 */
/** Twelve contracts, one per module, disjoint write scopes under docs/. */
const REAL_PROJECT_PLAN = {
  "topology": "fan-out",
  "contracts": [
    {
      "id": "doc-auth",
      "objective": "Write a concise reference document for auth in /home/nix/cubicore-test/src/auth.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/auth.ts"
      ],
      "writes": [
        "docs/doc-auth.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-auth.md exists and names auth",
      "checks": [
        {
          "id": "doc-auth-doc",
          "kind": "intent",
          "command": "test -f docs/doc-auth.md && grep -q 'auth' docs/doc-auth.md",
          "expectation": "docs/doc-auth.md exists and names auth",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-bytes",
      "objective": "Write a concise reference document for bytes in /home/nix/cubicore-test/src/bytes.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/bytes.ts"
      ],
      "writes": [
        "docs/doc-bytes.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-bytes.md exists and names bytes",
      "checks": [
        {
          "id": "doc-bytes-doc",
          "kind": "intent",
          "command": "test -f docs/doc-bytes.md && grep -q 'bytes' docs/doc-bytes.md",
          "expectation": "docs/doc-bytes.md exists and names bytes",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-cache",
      "objective": "Write a concise reference document for cache in /home/nix/cubicore-test/src/cache.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/cache.ts"
      ],
      "writes": [
        "docs/doc-cache.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-cache.md exists and names cache",
      "checks": [
        {
          "id": "doc-cache-doc",
          "kind": "intent",
          "command": "test -f docs/doc-cache.md && grep -q 'cache' docs/doc-cache.md",
          "expectation": "docs/doc-cache.md exists and names cache",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-chunk",
      "objective": "Write a concise reference document for chunk in /home/nix/cubicore-test/src/chunk.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/chunk.ts"
      ],
      "writes": [
        "docs/doc-chunk.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-chunk.md exists and names chunk",
      "checks": [
        {
          "id": "doc-chunk-doc",
          "kind": "intent",
          "command": "test -f docs/doc-chunk.md && grep -q 'chunk' docs/doc-chunk.md",
          "expectation": "docs/doc-chunk.md exists and names chunk",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-debounce",
      "objective": "Write a concise reference document for debounce in /home/nix/cubicore-test/src/debounce.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/debounce.ts"
      ],
      "writes": [
        "docs/doc-debounce.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-debounce.md exists and names debounce",
      "checks": [
        {
          "id": "doc-debounce-doc",
          "kind": "intent",
          "command": "test -f docs/doc-debounce.md && grep -q 'debounce' docs/doc-debounce.md",
          "expectation": "docs/doc-debounce.md exists and names debounce",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-duration",
      "objective": "Write a concise reference document for duration in /home/nix/cubicore-test/src/duration.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/duration.ts"
      ],
      "writes": [
        "docs/doc-duration.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-duration.md exists and names duration",
      "checks": [
        {
          "id": "doc-duration-doc",
          "kind": "intent",
          "command": "test -f docs/doc-duration.md && grep -q 'duration' docs/doc-duration.md",
          "expectation": "docs/doc-duration.md exists and names duration",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-groupBy",
      "objective": "Write a concise reference document for groupBy in /home/nix/cubicore-test/src/groupBy.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/groupBy.ts"
      ],
      "writes": [
        "docs/doc-groupBy.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-groupBy.md exists and names groupBy",
      "checks": [
        {
          "id": "doc-groupBy-doc",
          "kind": "intent",
          "command": "test -f docs/doc-groupBy.md && grep -q 'groupBy' docs/doc-groupBy.md",
          "expectation": "docs/doc-groupBy.md exists and names groupBy",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-mail",
      "objective": "Write a concise reference document for mail in /home/nix/cubicore-test/src/mail.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/mail.ts"
      ],
      "writes": [
        "docs/doc-mail.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-mail.md exists and names mail",
      "checks": [
        {
          "id": "doc-mail-doc",
          "kind": "intent",
          "command": "test -f docs/doc-mail.md && grep -q 'mail' docs/doc-mail.md",
          "expectation": "docs/doc-mail.md exists and names mail",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-queue",
      "objective": "Write a concise reference document for queue in /home/nix/cubicore-test/src/queue.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/queue.ts"
      ],
      "writes": [
        "docs/doc-queue.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-queue.md exists and names queue",
      "checks": [
        {
          "id": "doc-queue-doc",
          "kind": "intent",
          "command": "test -f docs/doc-queue.md && grep -q 'queue' docs/doc-queue.md",
          "expectation": "docs/doc-queue.md exists and names queue",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-slug",
      "objective": "Write a concise reference document for slug in /home/nix/cubicore-test/src/slug.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/slug.ts"
      ],
      "writes": [
        "docs/doc-slug.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/throttle.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-slug.md exists and names slug",
      "checks": [
        {
          "id": "doc-slug-doc",
          "kind": "intent",
          "command": "test -f docs/doc-slug.md && grep -q 'slug' docs/doc-slug.md",
          "expectation": "docs/doc-slug.md exists and names slug",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-throttle",
      "objective": "Write a concise reference document for throttle in /home/nix/cubicore-test/src/throttle.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/throttle.ts"
      ],
      "writes": [
        "docs/doc-throttle.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-throttle.md exists and names throttle",
      "checks": [
        {
          "id": "doc-throttle-doc",
          "kind": "intent",
          "command": "test -f docs/doc-throttle.md && grep -q 'throttle' docs/doc-throttle.md",
          "expectation": "docs/doc-throttle.md exists and names throttle",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    },
    {
      "id": "doc-wrap",
      "objective": "Write a concise reference document for wrap in /home/nix/cubicore-test/src/wrap.ts. Cover the signature, every parameter, the return value, and one worked example. State edge cases explicitly.",
      "reads": [
        "/home/nix/cubicore-test/src/wrap.ts"
      ],
      "writes": [
        "docs/doc-wrap.md"
      ],
      "forbidden": [
        "/home/nix/cubicore-test/src/auth.ts",
        "/home/nix/cubicore-test/src/bytes.ts",
        "/home/nix/cubicore-test/src/cache.ts",
        "/home/nix/cubicore-test/src/chunk.ts",
        "/home/nix/cubicore-test/src/debounce.ts",
        "/home/nix/cubicore-test/src/duration.ts",
        "/home/nix/cubicore-test/src/groupBy.ts",
        "/home/nix/cubicore-test/src/mail.ts",
        "/home/nix/cubicore-test/src/queue.ts",
        "/home/nix/cubicore-test/src/slug.ts",
        "/home/nix/cubicore-test/src/throttle.ts"
      ],
      "deliverable": "report",
      "schema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array"
          }
        }
      },
      "doneWhen": "docs/doc-wrap.md exists and names wrap",
      "checks": [
        {
          "id": "doc-wrap-doc",
          "kind": "intent",
          "command": "test -f docs/doc-wrap.md && grep -q 'wrap' docs/doc-wrap.md",
          "expectation": "docs/doc-wrap.md exists and names wrap",
          "gating": "blocking",
          "convergent": true
        }
      ],
      "budget": {
        "tokens": 40000,
        "toolCalls": 60,
        "wallMs": 240000
      }
    }
  ],
  "graphBudget": {
    "nodes": 12,
    "edges": 1,
    "tokens": 480000,
    "wallMs": 2880000
  }
} as unknown as PlanShape;


export const CORPUS: TaskSpec[] = [
  {
    id: "t1-explain",
    // Separable by file. Read-only, so no collision is even possible.
    prompt:
      "Read src/module-{N}.ts and reply with a two-sentence summary of what it does. " +
      "Reply with the summary and nothing else. Replace {N} with your file's number.",
    expectedWorkers: 4,
  },
  {
    id: "t2-docstring",
    // Separable by file, and each worker writes only its own.
    prompt:
      "Add a one-line JSDoc comment above the exported function in src/module-{N}.ts " +
      "describing what it returns. Do not change anything else. " +
      "Replace {N} with your file's number.",
    expectedWorkers: 4,
  },
  {
    id: "t3-real-project",
    // Twelve contracts against the real module set of a working project, with
    // the plan written by hand and checked by the validator. The first two
    // tasks measure the bootstrap floor on synthetic files; this one measures
    // Cubicore against real code with real per-file work.
    prompt:
      "Document every exported module in src/. One document per module, in docs/.",
    expectedWorkers: 12,
    plan: REAL_PROJECT_PLAN,
  },
];

/** Expands `{N}` into a 1-based worker index. */
export function promptFor(spec: TaskSpec, index: number): string {
  return spec.prompt.replace(/\{N\}/g, String(index + 1));
}