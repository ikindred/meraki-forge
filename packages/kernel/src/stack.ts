export interface RepoFile {
  readonly path: string;
  readonly content: string;
}
export interface StackEvidence {
  readonly module: string;
  readonly category:
    "language" | "framework" | "database" | "testing" | "tooling";
  readonly name: string;
  readonly source: string;
  readonly confidence: number;
}
export interface StackProfile {
  readonly evidence: readonly StackEvidence[];
  readonly unknown: boolean;
}

function add(
  out: StackEvidence[],
  file: RepoFile,
  category: StackEvidence["category"],
  name: string,
  confidence = 1,
): void {
  out.push({
    module: file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : ".",
    category,
    name,
    source: file.path,
    confidence,
  });
}

export function detectStack(files: readonly RepoFile[]): StackProfile {
  const out: StackEvidence[] = [];
  for (const file of files) {
    const base = file.path.split("/").at(-1);
    if (base === "package.json") {
      let pkg: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      } = {};
      try {
        pkg = JSON.parse(file.content) as typeof pkg;
      } catch {
        continue;
      }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      add(out, file, "language", "TypeScript/JavaScript", 0.8);
      if (deps.next) add(out, file, "framework", "Next.js");
      if (deps.react) add(out, file, "framework", "React");
      if (deps["@playwright/test"]) add(out, file, "testing", "Playwright");
      if (deps["@supabase/supabase-js"])
        add(out, file, "database", "Supabase/PostgreSQL");
    } else if (base === "composer.json") {
      add(out, file, "language", "PHP");
      if (file.content.includes("laravel/framework"))
        add(out, file, "framework", "Laravel");
    } else if (base === "pubspec.yaml") {
      add(out, file, "language", "Dart");
      if (/\bflutter\s*:/.test(file.content))
        add(out, file, "framework", "Flutter");
    } else if (base === "pyproject.toml" || base === "requirements.txt") {
      add(out, file, "language", "Python");
      if (/fastapi/i.test(file.content)) add(out, file, "framework", "FastAPI");
    } else if (base === "pom.xml" || base === "build.gradle") {
      add(out, file, "language", base === "pom.xml" ? "Java" : "Java/Kotlin");
      if (/spring/i.test(file.content)) add(out, file, "framework", "Spring");
    } else if (base?.endsWith(".csproj")) {
      add(out, file, "language", "C#");
      add(out, file, "framework", ".NET");
    } else if (base === "go.mod") add(out, file, "language", "Go");
    else if (base === "Cargo.toml") add(out, file, "language", "Rust");
    else if (
      /^(Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/.test(base ?? "")
    )
      add(out, file, "tooling", "Docker");
  }
  const unique = [
    ...new Map(
      out.map((item) => [`${item.module}:${item.category}:${item.name}`, item]),
    ).values(),
  ].sort((a, b) =>
    `${a.module}:${a.category}:${a.name}`.localeCompare(
      `${b.module}:${b.category}:${b.name}`,
    ),
  );
  return deepReadonly({ evidence: unique, unknown: unique.length === 0 });
}
function deepReadonly<T>(value: T): T {
  return Object.freeze(value);
}
