import { describe, expect, test } from "bun:test";
import type { Check, Contract, Plan } from "../../src/contracts/types";
import { validatePlan } from "../../src/validate/plan";

function blockingCheck(overrides: Partial<Check> = {}): Check {
  return {
    id: "unit",
    kind: "intent",
    command: "npm test -- src/a",
    expectation: "exit code 0",
    gating: "blocking",
    convergent: true,
    ...overrides,
  };
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "do the thing",
    reads: ["src/a.ts"],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "npm test -- src/a passes",
    checks: [blockingCheck()],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    topology: "fan-out",
    contracts: [contract()],
    graphBudget: { nodes: 8, edges: 16, tokens: 100_000, wallMs: 600_000 },
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validatePlan>): string[] {
  return result.findings.map((f) => f.code);
}

describe("validatePlan", () => {
  test("accepts a well-formed single contract", () => {
    expect(validatePlan(plan()).ok).toBe(true);
  });

  test("treats refusal as a valid outcome", () => {
    const result = validatePlan(plan({ topology: "refuse", contracts: [] }));
    expect(result.ok).toBe(true);
  });

  test("rejects an empty plan", () => {
    expect(codes(validatePlan(plan({ contracts: [] })))).toContain("empty-plan");
  });

  test("rejects duplicate contract ids", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ id: "w1" }), contract({ id: "w1" })] }),
    );
    expect(codes(result)).toContain("duplicate-id");
  });

  test("rejects two workers writing the same file", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/a.ts"] }),
          contract({ id: "w2", writes: ["src/a.ts"] }),
        ],
      }),
    );
    expect(codes(result)).toContain("write-collision");
  });

  test("rejects write overlap hidden behind globs", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/**"] }),
          contract({ id: "w2", writes: ["src/deep/b.ts"] }),
        ],
      }),
    );
    expect(codes(result)).toContain("write-collision");
  });

  test("allows disjoint write sets", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/frontend/**"] }),
          contract({ id: "w2", writes: ["src/backend/**"] }),
        ],
      }),
    );
    expect(codes(result)).not.toContain("write-collision");
  });

  test("allows overlapping reads", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", reads: ["src/**"], writes: ["src/a.ts"] }),
          contract({ id: "w2", reads: ["src/**"], writes: ["src/b.ts"] }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects writing into another contract's forbidden set", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/a.ts"] }),
          contract({ id: "w2", writes: ["src/b.ts"], forbidden: ["src/**"] }),
        ],
      }),
    );
    expect(codes(result)).toContain("writes-forbidden");
  });

  test("requires a blocking check for a diff deliverable", () => {
    const bare = contract({ checks: [] });
    expect(codes(validatePlan(plan({ contracts: [bare] })))).toContain(
      "no-blocking-check",
    );
  });

  test("an advisory-only check is not a gate", () => {
    const advisory = contract({
      checks: [blockingCheck({ gating: "advisory" })],
    });
    expect(codes(validatePlan(plan({ contracts: [advisory] })))).toContain(
      "no-blocking-check",
    );
  });

  test("does not require a blocking check for report deliverables", () => {
    const report = contract({ deliverable: "report", checks: [] });
    expect(validatePlan(plan({ contracts: [report] })).ok).toBe(true);
  });

  test("rejects a blocking check that cannot converge", () => {
    const stuck = contract({
      checks: [blockingCheck({ convergent: false })],
    });
    expect(codes(validatePlan(plan({ contracts: [stuck] })))).toContain(
      "invalid-check",
    );
  });

  test("rejects a contract with a non-positive budget", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ budget: { tokens: 0, toolCalls: 5, wallMs: 5 } })],
      }),
    );
    expect(codes(result)).toContain("invalid-budget");
  });

  test("rejects contract budgets that exceed the graph ceiling", () => {
    const result = validatePlan(
      plan({ graphBudget: { nodes: 8, edges: 16, tokens: 100, wallMs: 600_000 } }),
    );
    expect(codes(result)).toContain("budget-exceeded");
  });

  test("rejects a graph budget too small to hold the contracts", () => {
    const result = validatePlan(
      plan({ graphBudget: { nodes: 0, edges: 0, tokens: 1, wallMs: 1 } }),
    );
    expect(codes(result)).toContain("budget-exceeded");
  });
});

function uiSmokeContract(overrides: Partial<Contract> = {}): Contract {
  return contract({
    id: "ui-smoke",
    objective: "launch the built app and walk the core flow in a browser",
    reads: [],
    writes: ["e2e/flow.spec.ts"],
    checks: [
      blockingCheck({
        id: "smoke",
        command: "npx playwright test",
        expectation: "exit code 0",
      }),
    ],
    ...overrides,
  });
}

function acceptanceBlock() {
  return [
    {
      name: "the app launches and the core action works",
      command: "npx playwright test tests/acceptance/flow.spec.ts",
    },
  ];
}

describe("ui smoke — the built app is walked, not just compiled", () => {
  test("a UI plan with no browser smoke is rejected", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ ui: true })] }),
    );
    expect(codes(result)).toContain("missing-ui-smoke");
  });

  test("a UI plan whose only gate is unit tests is still rejected", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ ui: true, checks: [blockingCheck({ command: "npm test -- src/app" })] }),
        ],
      }),
    );
    expect(codes(result)).toContain("missing-ui-smoke");
  });

  test("a UI plan with a smoke contract is not flagged", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ ui: true }), uiSmokeContract()] }),
    );
    expect(codes(result)).not.toContain("missing-ui-smoke");
  });

  test("cypress also satisfies the gate", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ ui: true }),
          uiSmokeContract({
            checks: [
              blockingCheck({ id: "e2e", command: "npx cypress run" }),
            ],
          }),
        ],
      }),
    );
    expect(codes(result)).not.toContain("missing-ui-smoke");
  });

  test("a back-end plan needs no browser smoke", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ writes: ["src/api.ts"] })] }),
    );
    expect(codes(result)).not.toContain("missing-ui-smoke");
  });
});

describe("reference — UI-capable plans inherit a specific look", () => {
  test("a UI plan with textures but no asset kit is rejected", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ ui: true, objective: "Paint the grass texture in code" }), uiSmokeContract()],
        design: {
          direction: "warm",
          palette: ["#0f0f0f", "#e6e6e6", "#527f3a", "#f4f0e6"],
          typeface: "JetBrains Mono",
          notDoing: ["no second typeface"],
          ambition: "calm",
        },
        reference: "file:///ref.png",
      }),
    );
    expect(codes(result)).toContain("missing-assets");
  });

  test("a UI plan with an asset kit naming textures passes missing-assets", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ ui: true, objective: "Paint the grass texture in code" }), uiSmokeContract()],
        design: {
          direction: "warm",
          palette: ["#0f0f0f", "#e6e6e6", "#527f3a", "#f4f0e6"],
          typeface: "JetBrains Mono",
          notDoing: ["no second typeface"],
          ambition: "calm",
          assets: [
            { name: "grass-top", kind: "texture", hex: "#527f3a", note: "Main solve — code-painted with noise clamp" },
            { name: "stone-face", kind: "texture", hex: "#a0988c", note: "Blocky faces via 4×4 p" },
          ],
        },
        reference: "file:///ref.png",
      }),
    );
    expect(codes(result)).not.toContain("missing-assets");
  });

  test("a UI plan without any texture/sprite keyword needs no assets block", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ ui: true }), uiSmokeContract()],
        design: {
          direction: "terminal",
          palette: ["#0f0f0f", "#e6e6e6", "#3b82f6"],
          typeface: "JetBrains Mono",
          notDoing: ["no second typeface"],
          ambition: "calm",
        },
        reference: "https://example.com/",
      }),
    );
    expect(codes(result)).not.toContain("missing-assets");
  });

  test("a UI plan without a reference is rejected", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ ui: true })] }),
    );
    expect(codes(result)).toContain("missing-reference");
  });

  test("a UI plan with a file:// reference passes", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ ui: true }), uiSmokeContract()],
        reference: "file:///home/nix/Projects/art/ref.png",
      }),
    );
    expect(codes(result)).not.toContain("missing-reference");
  });

  test("a UI plan with an absolute filesystem reference passes", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ ui: true }), uiSmokeContract()],
        reference: "/home/nix/Projects/art/ref.png",
      }),
    );
    expect(codes(result)).not.toContain("missing-reference");
  });

  test("a UI plan with a network reference (//host/path) is rejected", () => {
    const plan2 = plan({
      contracts: [contract({ ui: true }), uiSmokeContract()],
      reference: "//nfs-share/ref.png",
    });
    expect(codes(validatePlan(plan2))).toContain("missing-reference");
  });

  test("a UI plan with a reference is not rejected for absence of reference", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ ui: true }), uiSmokeContract()],
        reference: "https://example.com/artwork",
      }),
    );
    expect(codes(result)).not.toContain("missing-reference");
  });

  test("a back-end plan needs no reference", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ writes: ["src/api.ts"] })] }),
    );
    expect(codes(result)).not.toContain("missing-reference");
  });
});

describe("design elevation — UI-capable plans", () => {
  test("a UI contract without a design block is rejected", () => {
    const result = validatePlan(plan({
      contracts: [contract({ ui: true })],
    }));
    expect(codes(result)).toContain("missing-design");
  });

  test("a UI contract writing a screen-facing file needs the block even without ui:true", () => {
    const result = validatePlan(plan({
      contracts: [contract({ writes: ["src/page.tsx"] })],
    }));
    expect(codes(result)).toContain("missing-design");
  });

  test("a UI plan with a complete design block, a smoke contract and acceptance cases passes", () => {
    const result = validatePlan(plan({
      contracts: [contract({ ui: true, id: "app" }), uiSmokeContract()],
      reference: "https://no-country-can-build-that.art/",
      design: {
        direction: "terminal",
        palette: ["#0f0f0f", "#e6e6e6", "#3b82f6"],
        typeface: "JetBrains Mono",
        notDoing: ["no scrolljacking", "no second typeface", "no gradient"],
        ambition: "calm",
      },
      acceptance: acceptanceBlock(),
    }));
    expect(result.ok).toBe(true);
  });

  test("a UI plan with design and smoke but no acceptance cases is rejected", () => {
    const result = validatePlan(plan({
      contracts: [contract({ ui: true, id: "app" }), uiSmokeContract()],
      reference: "https://no-country-can-build-that.art/",
      design: {
        direction: "terminal",
        palette: ["#0f0f0f", "#e6e6e6", "#3b82f6"],
        typeface: "JetBrains Mono",
        notDoing: ["no scrolljacking", "no second typeface", "no gradient"],
        ambition: "calm",
      },
    }));
    expect(codes(result)).toContain("missing-acceptance");
  });

  test("an underspecified design is rejected with its missing parts named", () => {
    const result = validatePlan(plan({
      contracts: [contract({ ui: true })],
      design: {
        direction: "terminal",
        palette: ["#0f0f0f"],
        typeface: "JetBrains Mono",
        notDoing: [],
        ambition: "calm",
      } as never,
    }));
    expect(codes(result)).toContain("missing-design");
  });

  test("a back-end plan needs no design block", () => {
    const result = validatePlan(plan({
      contracts: [contract({ writes: ["src/api.ts"] })],
    }));
    expect(result.ok).toBe(true);
  });
});

describe("contrast — body text legibility", () => {
  const good = ["#0f0f0f", "#f5f5f0", "#3b82f6"];
  const mono = ["#777777", "#888888", "#999999"];

  test("passes when the palette contains one compliant pair", () => {
    const result = validatePlan(plan({
      contracts: [contract({ ui: true })],
      design: {
        direction: "terminal",
        palette: good,
        typeface: "JetBrains Mono",
        notDoing: ["no second typeface"],
        ambition: "calm",
      },
    }));
    expect(codes(result)).not.toContain("weak-contrast-palette");
  });

  test("rejects a monotonous palette that cannot produce legible body text", () => {
    const result = validatePlan(plan({
      contracts: [contract({ ui: true })],
      design: {
        direction: "warm-static",
        palette: mono,
        typeface: "Inter",
        notDoing: ["no second typeface"],
        ambition: "calm",
      },
    }));
    expect(codes(result)).toContain("weak-contrast-palette");
  });
});
