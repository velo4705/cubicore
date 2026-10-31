import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

/**
 * What is actually in this repository.
 *
 * "Build me a multi-million dollar SaaS" cannot be answered by asking a founder
 * questions: they do not know what files they have. Asking "which modules
 * should this touch?" to someone who cannot answer it produces a guess, and a
 * guess becomes contracts that claim everything.
 *
 * So the question has to be informed. Survey the tree first, then ask about
 * things that actually exist -- by name, with their real paths. A founder can
 * say "not billing" far more easily than they can invent `src/billing.ts`.
 *
 * Read-only and cheap: one directory walk, capped, and no file contents beyond
 * manifests.
 */

export interface ModuleInfo {
  path: string;
  kind: "source" | "test" | "config" | "docs" | "unknown";
  language: string | null;
  /** Exported names, when cheaply available. */
  exports: string[];
  lines: number;
}

export interface Survey {
  root: string;
  exists: boolean;
  languages: Record<string, number>;
  modules: ModuleInfo[];
  scripts: Record<string, string>;
  hasTests: boolean;
  totalFiles: number;
  truncated: boolean;
}

const SOURCE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go", ".rs": "Rust",
  ".rb": "Ruby", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".php": "PHP",
  ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".sh": "Shell",
};

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", "__pycache__",
  ".next", ".nuxt", ".cache", "coverage", ".venv", "venv", ".turbo", ".cubicore",
]);

const MAX_FILES = 2000;
const MAX_MODULES = 120;

export function survey(root: string): Survey {
  const empty: Survey = {
    root, exists: false, languages: {}, modules: [], scripts: {},
    hasTests: false, totalFiles: 0, truncated: false,
  };

  try {
    statSync(root);
  } catch {
    return empty;
  }

  const modules: ModuleInfo[] = [];
  const languages: Record<string, number> = {};
  let files = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || files >= MAX_FILES || modules.length >= MAX_MODULES) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);

      let dirent;
      try {
        dirent = statSync(full);
      } catch {
        continue;
      }

      if (dirent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      files++;

      const ext = extname(entry).toLowerCase();
      const rel = relative(root, full) || entry;
      const language = SOURCE[ext] ?? null;
      if (language) languages[language] = (languages[language] ?? 0) + 1;

      const isTest = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[a-z]+$|_test\./.test(rel);
      const isConfig = /^(\.|.*\.(json|ya?ml|toml|ini|lock)$)/.test(rel) || rel === "package.json";
      const isDoc = /\.(md|mdx|rst|txt)$/i.test(rel);

      if (!language && !isConfig) continue;
      if (modules.length >= MAX_MODULES) {
        truncated = true;
        continue;
      }

      modules.push({
        path: rel,
        kind: isTest ? "test" : isDoc ? "docs" : isConfig ? "config" : "source",
        language,
        exports: isTest || !language ? [] : readExports(full),
        lines: countLines(full, dirent.size),
      });

      if (isTest) empty.hasTests = true;
    }
  };

  walk(root, 0);

  return {
    root,
    exists: true,
    languages,
    modules,
    scripts: readScripts(root),
    hasTests: modules.some((m) => m.kind === "test"),
    totalFiles: files,
    truncated,
  };
}

function readExports(path: string): string[] {
  try {
    const text = readFileSync(path, "utf8");
    const found = new Set<string>();
    const patterns = [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      /export\s+class\s+([A-Za-z_$][\w$]*)/g,
      /export\s+interface\s+([A-Za-z_$][\w$]*)/g,
      /export\s+type\s+([A-Za-z_$][\w$]*)/g,
      /^\s*(?:def|class)\s+([A-Za-z_][\w]*)/gm,
      /^func\s+([A-Za-z_][\w]*)/gm,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) found.add(match[1]);
      if (found.size > 40) break;
    }
    return [...found].slice(0, 40);
  } catch {
    return [];
  }
}

function countLines(path: string, size: number): number {
  // Large files are counted by estimate: reading a bundle to count newlines is
  // not worth the IO.
  if (size > 512 * 1024) return -1;
  try {
    return readFileSync(path, "utf8").split("\n").length;
  } catch {
    return -1;
  }
}

function readScripts(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** Render the survey as the briefing a planner should read before asking. */
export function render(s: Survey): string {
  // No project to survey. Returning only "nothing to survey" left the agent
  // searching with the shell for something that was not there. Give it the
  // conventional starting points instead, so the question is answerable.
  if (!s.exists) {
    return [`No project at ${s.root}.`].join("\n");
  }

  const lines = [
    `# ${s.root}`,
    ``,
    s.totalFiles > 0 ? `${s.totalFiles} files.` : "Empty directory.",
    Object.keys(s.languages).length > 0
      ? `Languages: ${Object.entries(s.languages).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(", ")}`
      : "No recognised source files yet.",
    s.hasTests ? "Has tests." : "No tests found.",
    ``,
  ];

  const scripts = Object.entries(s.scripts);
  if (scripts.length > 0) {
    lines.push(`## Existing commands`, ``, ...scripts.map(([k, v]) => `- \`npm run ${k}\` — ${v}`), ``);
  }

  const source = s.modules.filter((m) => m.kind === "source");
  if (source.length > 0) {
    lines.push(`## Modules that exist — the candidate write scopes`, ``);
    for (const m of source.slice(0, 40)) {
      const ex = m.exports.length > 0 ? ` → ${m.exports.slice(0, 6).join(", ")}` : "";
      lines.push(`- \`${m.path}\`${m.lines > 0 ? ` (${m.lines} lines)` : ""}${ex}`);
    }
    if (source.length > 40) lines.push(`- …and ${source.length - 40} more`);
    lines.push(``);
  }

  if (s.truncated) {
    lines.push(`_Survey truncated; the tree is larger than the cap._`, ``);
  }

  if (s.totalFiles === 0) {
    lines.push(`The project is empty.`);
  }

  return lines.join("\n");
}

/**
 * Questions grounded in what actually exists.
 *
 * A founder who cannot name a file can still say "not billing" when shown the
 * list. Naming real paths turns an unanswerable question into a choice.
 */
export function questionsFrom(s: Survey): string[] {
  // A directory that exists but holds nothing is greenfield, not missing. The
  // question differs: there is no code to point at, so ask what to create.
  if (!s.exists || (s.exists && s.totalFiles === 0)) {
    return [
      "The user's request is in the conversation history above. Use that as the scope; do not invent a project.",
      "What language and tooling should it use?",
    ];
  }

  const q: string[] = [];
  const source = s.modules.filter((m) => m.kind === "source");

  q.push(
    `This project has ${s.totalFiles} files` +
      (source.length ? ` across ${source.length} source modules` : "") +
      `. Which of them should this work actually touch? Here they are: ` +
      (source.length
        ? source.slice(0, 12).map((m) => `\`${m.path}\``).join(", ") + (source.length > 12 ? ", …" : "")
        : "(none yet)") +
      ` — say which, or say none and this is a greenfield build.`,
  );

  if (!s.hasTests) {
    q.push("There are no tests. What command should prove this works once written?");
  } else {
    q.push("Which test command gates this work, and should new behaviour come with new tests?");
  }

  const scriptNames = Object.keys(s.scripts);
  if (scriptNames.length > 0) {
    q.push(`Existing scripts are ${scriptNames.map((n) => `\`${n}\``).join(", ")}. Which of them must stay green?`);
  } else if (s.languages && Object.keys(s.languages).includes("TypeScript")) {
    q.push("There is no package.json script. What should the typecheck and test commands be?");
  }

  return q;
}