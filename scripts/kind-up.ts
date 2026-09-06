#!/usr/bin/env bun
/**
 * Create the local Kubernetes cluster this repository's k8s recipes default to.
 *
 * IDEMPOTENT: an existing cluster of the same name is left alone. `kind create`
 * errors on a name it already has, which would make `just kind-up` a command
 * you can only run once — wrong for something every k8s recipe wants to
 * depend on.
 *
 * IT WAITS TWICE, AND WHAT THE SECOND WAIT BUYS IS THE POINT. `kind create
 * --wait` waits for the NODE to report Ready; every pod in `kube-system` is
 * still starting when it returns — measured, not assumed. The second wait
 * makes one guarantee: when this script exits 0, cluster DNS is serving.
 *
 * That guarantee is what a caller needs, because deploy mode wires
 * cross-component traffic through Service DNS (D-020), so a suite that starts
 * before DNS is up cannot resolve anything and reports timeouts naming the
 * components rather than the resolution that failed.
 *
 * It is worth being exact about the scope of that, because this wait was found
 * while chasing something else and does not fix it: the petstore example is
 * unreliable on kind for an unrelated reason (D-049). This wait removes one
 * deterministic startup race. It does not make that example reliable.
 */

const CONTEXT = process.env.CYANOTYPE_K8S_CONTEXT ?? "kind-cyanotype";
const CLUSTER = CONTEXT.replace(/^kind-/, "");

const run = (cmd: string[]) =>
  Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });

const existing = Bun.spawnSync(["kind", "get", "clusters"], { stdout: "pipe", stderr: "pipe" });
const names = existing.stdout.toString().split("\n").map((l) => l.trim());

if (!names.includes(CLUSTER)) {
  const created = run(["kind", "create", "cluster", "--name", CLUSTER, "--wait", "120s"]);
  if (created.exitCode !== 0) process.exit(created.exitCode ?? 1);
}

const dns = run([
  "kubectl", "--context", CONTEXT, "-n", "kube-system",
  "wait", "--for=condition=Ready", "pods", "--all", "--timeout=120s",
]);
process.exit(dns.exitCode ?? 1);
