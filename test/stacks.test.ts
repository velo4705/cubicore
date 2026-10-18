import { describe, expect, it } from "bun:test";

import { inferStack, stacksIn, dispatchBlueprint } from "../src/mcp/inline";
import { parsePlan } from "../src/coordinator/parse";
import type { Contract, Plan } from "../src/contracts/types";

/**
 * One stack per associate, never a blend. An associate owning "backend and a
 * bit of design" owns two write scopes that overlap the design associate's,
 * which is the collision the system exists to prevent.
 */

const c = (id: string, writes: string[], objective = "Implement the module"): Contract =>
  ({
    id,
    objective,
    reads: [],
    writes,
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "done",
    checks: [
      { id: "k", kind: "intent", command: "bunx --bun tsx -e \"assert(1)\"", expectation: "e", gating: "blocking", convergent: true },
    ],
    budget: { tokens: 30_000, toolCalls: 60, wallMs: 120_000 },
  }) as unknown as Contract;

const planOf = (contracts: Contract[]): Plan =>
  parsePlan(
    JSON.stringify({
      topology: "fan-out",
      contracts,
      graphBudget: { nodes: 4, edges: 1, tokens: 120_000, wallMs: 480_000 },
    }),
  ) as Plan;

describe("stack inference", () => {
  it("reads a stack from the write scope, not the id alone", () => {
    expect(inferStack(c("a", ["src/styles/tokens.ts"]))).toBe("design");
    expect(inferStack(c("a", ["src/api/routes.ts"]))).toBe("backend");
    expect(inferStack(c("a", ["src/components/App.tsx"]))).toBe("frontend");
    // .css is frontend by extension; "design" is reached through src/styles/.
    expect(inferStack(c("a", ["src/styles/theme.css"]))).toBe("frontend");
    expect(inferStack(c("a", ["prisma/schema.prisma"]))).toBe("data");
  });

  it("falls back to backend when nothing suggests a stack", () => {
    expect(inferStack(c("thing", ["src/misc.ts"]))).toBe("backend");
  });

  it("lists each distinct stack once", () => {
    const stacks = stacksIn(
      planOf([c("a", ["src/api/one.ts"]), c("b", ["src/api/two.ts"]), c("c", ["src/App.tsx"])]),
    );
    expect(stacks.sort()).toEqual(["backend", "frontend"]);
  });

  it("names the stack on every instruction so an associate knows its lane", () => {
    const md = dispatchBlueprint(planOf([c("a", ["src/api/one.ts"]), c("b", ["src/App.tsx"])]));
    const stackLines = md.split("\n").filter((l) => l.startsWith("**Stack:**"));
    expect(stackLines).toHaveLength(2);
    expect(md).toContain("**Stack:** backend");
    expect(md).toContain("**Stack:** frontend");
  });

  it("states that every stack needs at least one associate", () => {
    const md = dispatchBlueprint(planOf([c("a", ["src/api/one.ts"]), c("b", ["src/App.tsx"])]));
    expect(md).toContain("Every stack listed above needs at least one associate");
    expect(md).toContain("no maximum");
  });

  it("never gives one associate two stacks", () => {
    const md = dispatchBlueprint(planOf([c("a", ["src/api/one.ts"]), c("b", ["src/App.tsx"])]));
    const perContract = md.split("# Contract ").slice(1);
    for (const block of perContract) {
      const stacks = block.split("\n").filter((l) => l.startsWith("**Stack:**"));
      expect(stacks).toHaveLength(1);
    }
  });
});
