#!/usr/bin/env bun
/**
 * Gate: can a consumer actually compile against the packed library?
 *
 * Silent and exit 0 when every consumer compiles; on a miss, the whole reason
 * between two `[GATE]` lines and a non-zero exit.
 *
 * WHY THIS EXISTS AS A SEPARATE HARNESS. Every other suite in this repository
 * runs INSIDE the repository, where `zod` resolves to the one copy in our own
 * node_modules and `@types/bun` is always installed. A consumer's project has
 * neither guarantee, and two defects shipped in v0.7.1 because nothing here
 * could see across that boundary:
 *
 *   - The published .d.ts declared `import type { Subprocess } from "bun"`.
 *     `@types/bun` is a devDependency, so any consumer compiling with
 *     `skipLibCheck: false` failed on `Cannot find module 'bun'` for a type
 *     they never referenced.
 *   - `zod` was a normal dependency pinned to `^3`, so a consumer on zod 4 got
 *     zod 3 installed underneath us. Their `z.object(...)` then failed to
 *     satisfy our `ZodTypeAny`, which resolved to the nested copy.
 *
 * Both are invisible from inside. The only way to catch them is to build the
 * package the way npm builds it and compile something against it, which is
 * what this does.
 *
 * `skipLibCheck: false` is deliberate and is the point of the exercise. Most
 * consumers leave it true and would not have seen the "bun" failure, but a
 * published type that only works when the consumer disables checking is a
 * defect we should hear about from a gate rather than an issue report.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The zod majors the `peerDependencies` range promises to support. */
const ZOD_RANGES = ["3", "4"] as const;

const CONSUMER = `
import { z } from "zod";
import { http, iface, defineBlueprint } from "@expelledboy/cyanotype";
import { K8sAdapterConfigSchema } from "@expelledboy/cyanotype";

// The boundary that matters: a schema built with the CONSUMER's zod, handed to us.
const routes = {
  ping: { method: "GET", path: "/", response: z.object({ ok: z.boolean() }) },
} as const;

export const bp = defineBlueprint({
  portNames: ["3000"] as const,
  interface: (_c, _e, ports) => ({
    http: iface({ uri: \`http://127.0.0.1:\${ports["3000"]}\`, protocol: http(routes) }),
  }),
});

// An exported schema constant, parsed with the consumer's own zod runtime.
export const cfg = K8sAdapterConfigSchema.parse({});
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2022",
    noEmit: true,
    // Deliberate — see the header.
    skipLibCheck: false,
  },
}, null, 2);

const run = (cmd: string, args: string[], cwd: string): { ok: boolean; out: string } => {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const failures: string[] = [];

process.stderr.write("  packing\n");
const packDir = mkdtempSync(join(tmpdir(), "cyanotype-pack-"));
const packed = run("npm", ["pack", "--pack-destination", packDir], process.cwd());
if (!packed.ok) {
  console.error("[GATE] consumer types");
  console.error("— npm pack failed, so no consumer could be built:");
  console.error(packed.out.trim());
  console.error("[GATE] consumer types");
  process.exit(1);
}
const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz")) as string);

for (const major of ZOD_RANGES) {
  process.stderr.write(`  consumer on zod ${major}\n`);
  const dir = mkdtempSync(join(tmpdir(), `cyanotype-consumer-zod${major}-`));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `c-zod${major}`, private: true, type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "src/app.ts"), CONSUMER);

  const install = run("npm", ["i", "--silent", "--no-audit", "--no-fund", tarball, `zod@${major}`, "typescript@5"], dir);
  if (!install.ok) {
    failures.push(`— consumer on zod ${major}: npm install failed`, ...install.out.trim().split("\n").map((l) => `  ${l}`), "");
    rmSync(dir, { recursive: true, force: true });
    continue;
  }

  const tsc = run("npx", ["tsc", "--noEmit"], dir);
  if (!tsc.ok) {
    failures.push(
      `— a consumer whose project uses zod ${major} cannot compile against this package`,
      ...tsc.out.trim().split("\n").map((l) => `  ${l}`),
      `  package.json promises this works: zod ${major} is inside the peerDependencies range.`,
      "  A `Cannot find module` here means a published .d.ts references a type the",
      "  consumer has no reason to have installed — declare that type locally instead.",
      "  A zod assignability error means their zod and ours resolved to different copies.",
      "",
    );
  }
  rmSync(dir, { recursive: true, force: true });
}
rmSync(packDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("[GATE] consumer types");
  for (const line of failures) console.error(line);
  console.error("[GATE] consumer types");
  process.exit(1);
}
