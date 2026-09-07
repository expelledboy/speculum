# Contributing

> Workflow and process. Read [`CONVENTIONS.md`](./CONVENTIONS.md) first for the code-style rules and [`docs/axioms.md`](./docs/axioms.md) for the design constraints.

## Dev setup

You need:

- **[Bun](https://bun.sh)** `~1.3` or newer — the test runner and dev runtime.
- **Docker** running locally (Engine 20.10+) — for the integration tests against
  real images. Docker Desktop, OrbStack and plain Linux Docker all work; the
  adapter no longer assumes the runtime defines `host.docker.internal` (D-048).
- **[just](https://github.com/casey/just)** — task runner. `brew install just`, or `nix develop` (the flake provides it).
- **[kind](https://kind.sigs.k8s.io)** and **`kubectl`** — for the Kubernetes
  suites. `brew install kind kubectl`.

Then:

```sh
bun install
just kind-up      # creates the `cyanotype` kind cluster the k8s recipes default to
```

### Which Kubernetes cluster

The k8s recipes default to kubectl context `kind-cyanotype`, which `just
kind-up` creates. kind is the standard here because continuous integration runs
the Kubernetes adapter suites against it on every pull request, so it is the one
cluster whose behaviour is continuously checked.

Set `CYANOTYPE_K8S_CONTEXT` to use a cluster you already have. OrbStack's and
Docker Desktop's built-in clusters need no image copying, because they run
Kubernetes against the same image store as the host Docker daemon — an image
you just built is already visible to them. This document calls those
**shared-image-store clusters**. kind gives each node its own store, so images
must be copied in, which `just test-petstore-k8s` does for you. Nothing
verifies the shared-store clusters automatically, so a break there will be
found by a person rather than by CI.

**Two recipes need a shared-image-store cluster today.** `just
test-petstore-k8s` and `just test-petstore-k8s-attach` are not reliable on kind,
and neither is `just pre-release`, which runs them. Point
`CYANOTYPE_K8S_CONTEXT` at OrbStack or Docker Desktop for those three. The
reason, the measurements and the condition for revisiting it are in
[D-049](./docs/decisions.md#d-049-ci-runs-the-kubernetes-adapter-suites-not-the-example--one-port-forward-per-component-is-not-yet-survivable).

The **adapter suites** — `just test-adapter-k8s` and `just
test-adapter-k8s-attach`, which live in `tests/substrate/` and exercise one
adapter directly rather than a whole example environment — drive one component
at a time and are unaffected. They are safe on kind, and are what CI runs.

### Co-developing against a consumer repo via a `file:` pin

If a consumer pins Cyanotype locally — e.g. `"@expelledboy/cyanotype": "file:../../path/to/this-checkout"` — then `bunx @expelledboy/cyanotype derive ...` from the consumer side resolves against the **on-disk `dist/cli/index.js`** of this checkout. The CLI is only emitted by `bun run build` (`tsc -p tsconfig.build.json`). Two consequences:

- After changing anything under `src/cli/`, run `bun run build` in this repo before retrying `bunx` from the consumer side. Otherwise `bunx` invokes a stale (or, if `dist/` is absent, fails outright with "could not determine executable").
- After switching a consumer from a `file:` pin to a semver pin (e.g. `^0.3.1`), delete the consumer's `node_modules/@expelledboy/cyanotype` and re-run `bun install` — Bun does not always replace a directory-symlinked dep with a fresh tarball.

Switch to a semver pin once your library change has landed in a published release; that avoids the dist/build coupling entirely.

## Run the tests

Four layers, cheapest first. `just --list` is the full manifest; this is the
shape behind it.

**The inner loop — no daemon, no cluster.** Seconds. Run it constantly.

```sh
just typecheck
just test-unit          # tests/core/ — the harness's own tests, all pure
```

**Adapter integration — needs a Docker daemon; two of its six files also need
a Kubernetes cluster.**

```sh
just test-substrate     # tests/substrate/ — each adapter driven directly
```

A substrate you do not have makes its suites report `skip`, not `pass`. That
distinction is load-bearing: these suites once reported 22 passing tests while
executing no assertions at all, because each body opened with an early return.
Set `CYANOTYPE_REQUIRE_DOCKER=1` or `CYANOTYPE_REQUIRE_K8S=1` to turn an absent
substrate into a failure instead — which is what continuous integration does,
because it provisions them first and their absence would mean the provisioning
step silently did nothing.

**The example, across substrates.** `tests/petstore-example/` is the same 16
tests run against every adapter; it is what backs the claim that a suite does
not change when its substrate does.

```sh
just test-petstore-memory          # in-process fakes, no daemon
just test-petstore-docker          # real containers
just test-petstore-docker-attach   # a Compose stack this brings up and tears down
just test-petstore-k8s             # needs a shared-image-store cluster
just test-petstore-k8s-attach      # needs a shared-image-store cluster
```

The last two are not reliable on kind ([D-049](./docs/decisions.md#d-049-ci-runs-the-kubernetes-adapter-suites-not-the-example--one-port-forward-per-component-is-not-yet-survivable)). Point
`CYANOTYPE_K8S_CONTEXT` at OrbStack or Docker Desktop for those.

**Everything, plus what only a release cares about.**

```sh
just test               # the whole tree in one process
just pre-release        # the release gate — see below
```

Supporting commands: `just build-test-images` builds the two images the example
needs, and `just clean-containers` force-removes orphans after a run killed
mid-suite. Neither is needed on the normal path; the preload handles cleanup.

### What checks what

| | CI, on every pull request | `just pre-release` |
|---|---|---|
| lint, typecheck, build, `tests/core/` | yes | yes |
| `tests/substrate/` | yes | yes |
| package contents | yes | yes |
| example on memory, Docker, Compose-attach | yes | yes |
| example on Kubernetes | **no** — [D-049](./docs/decisions.md#d-049-ci-runs-the-kubernetes-adapter-suites-not-the-example--one-port-forward-per-component-is-not-yet-survivable) | yes |
| leak gate | yes | yes |
| built command-line interface | no | yes |
| git state, tag, CHANGELOG, lockfile | no | yes |

The release gate is a strict superset. Green CI is necessary and not
sufficient, and the gap between the columns is exactly the release-shaped risk.

### How teardown works

`bun test` runs all files in a single process. `bunfig.toml` registers `tests/preload.ts` as a preload script; that file's top-level `afterAll` (from `bun:test`) fires once after the entire run and calls `shared.stopAll()`. The harness stops cached runtimes, then reconnects briefly to force-clean any session-labelled stragglers, then disconnects. No orphan containers remain between runs.

**Docker Compose attach mode is non-destructive and requires manual teardown.** When running `CYANOTYPE_ADAPTER=docker-attach`, Cyanotype never removes the Compose stack's containers — they must be stopped with `docker compose down` when you're done. `just clean-containers` will **not** catch Compose containers because they lack the `cyanotype.substrate=docker` label that the cleanup filter targets.

If you wire your own integration suite for a Cyanotype-based project, you'll need the same pattern:

```ts
// tests/preload.ts
import { afterAll } from "bun:test";
import { shared } from "./your-harness";

// The timeout is not optional: bun:test allows a hook 5s by default, and
// stopping a multi-component environment exceeds that on slower machines.
afterAll(async () => {
  try { await shared.stopAll(); }
  catch (e) { console.error("[preload] stopAll failed:", e); }
}, 120_000);
```

```toml
# bunfig.toml
[test]
preload = ["./tests/preload.ts"]
```

## Making changes

### Code changes

- Follow `CONVENTIONS.md`.
- Every implementation module has a test file: `tests/core/<module>.test.ts` for anything testable without a substrate, `tests/substrate/<module>.test.ts` for adapter behaviour that needs a real Docker daemon or cluster. Add tests for new behaviour there.
- The end-to-end example in `tests/petstore-example/` is the integration smoke; if your change affects orchestration or the Adapter SPI, it should still pass.
- `just typecheck` must be clean.
- `just test-unit` must be clean — run it constantly, it takes seconds. It runs
  with runtime invariants enabled (`tests/preload.ts`), so a violated cross-module
  agreement fails there rather than as a confusing symptom later. Set
  `CYANOTYPE_INVARIANTS=1` to enable them outside this repo's suite. Then `just test-core` (adds substrate integration) and `just test` against real Docker.

### Adding a failure mode

Before adding a `throw`, decide whether it is a consumer's mistake (an error,
always on, carrying a `hint`) or an agreement between Cyanotype's own modules
(an `invariant()`, off in consumers' runs). The decision table is in
[`AGENTS.md`](./AGENTS.md#failures-invariant-or-error), and
`tests/core/error-classification.test.ts` will fail until the new error is
classified — that is intentional.

### Auditing hints

`just hints` prints every error, the condition that raises it, and the hint the
reader gets. Two automatic layers guard them — `hint-claims.test.ts` fails if a
hint references something that does not exist, `hint-remedies.test.ts` proves
the advice works by performing it — but neither can judge whether prose advice
is *sound*. That is what the catalogue is for: read it against the code when
touching error paths, and when adding a hint you cannot prove, phrase it as
something to check rather than a remedy to follow.

### Architectural changes

Anything that touches a load-bearing concept (Blueprint shape, Adapter SPI, Environment composition, cross-process registry, event-bus typing) needs an ADR in `docs/decisions.md`.

The ADR process:

1. Open a draft PR with the change.
2. Add an entry to `docs/decisions.md` at the end. Format:
   ```
   ## D-NNN. Title

   **Context:** Why this came up.
   **Decision:** What we're doing.
   **Consequences:** What this enables, breaks, or forecloses.
   ```
3. An ADR describes the decision **as it stands**, and must read cold — no assumed knowledge of what preceded it. Changing a decision takes a **new** ADR that names what it retires and why. Fixing a wrong figure, a broken path or an undefined term is done **in place**, with no erratum left behind. Keep the story of how the work went out of it; `git log` and `CHANGELOG.md` are where that lives.

### What to do when stuck

- **Spec ambiguous?** Stop and ask. Don't pick between two reasonable interpretations silently — that's how the project drifts.
- **Test would need a non-trivial fake?** Stop and ask. It's a design smell — the abstraction may need to move.
- **A module heading past 400 LoC?** Stop and ask. Most files are one concept and fit in ~200; past 400 either the module is eating a neighbour's job or the design is wrong. `CONVENTIONS.md` has the per-layer budgets and names the two files currently over it.

## PR shape

- One concern per PR. If you're adding a feature and refactoring, split them.
- The PR description states the *why*: what problem this solves, what the alternatives were, what's now possible (or impossible). The diff explains the *what*.
- Tests in the same PR as the change.
- If you added an ADR, link to it from the PR description.

## Pre-release checklist

Tags go on `master`, never on a branch: CI runs only on pull requests, so a
tag on an unmerged branch publishes code no CI has validated. Land the release
prep in the PR, merge, then tag `master`. The full cycle and the checks the
automation does not perform are in [`AGENTS.md`](./AGENTS.md#releasing).

Before tagging any `v*.*.*` and triggering `release.yml`, run:

```sh
just pre-release
```

It is a gate, not a list: silent and exit 0 when the tree is releasable,
otherwise every failing check between two `[GATE]` lines, and it tags nothing.
What it covers versus what CI covers is the table under
["What checks what"](#what-checks-what) — it is a strict superset, and it adds
the git and tag state, the CHANGELOG section the release workflow will extract,
the lockfile, the built command-line interface, and the two Kubernetes example
paths CI does not run.

It runs every suite with `CYANOTYPE_REQUIRE_DOCKER` and `CYANOTYPE_REQUIRE_K8S`
set, so a substrate it could not reach fails the gate rather than vanishing
from it. A release bar that quietly drops the suites it could not run is not a
bar. Point `CYANOTYPE_K8S_CONTEXT` at a shared-image-store cluster before
running it — see ["Which Kubernetes cluster"](#which-kubernetes-cluster).

It also smokes the built CLI, which is the one check with a story behind it:
`tests/core/cli-derive.test.ts` covers `deriveCompose` and `deriveK8s` as pure
functions, so nothing there catches argv parsing or subcommand routing, and
0.3.0 shipped a broken dispatcher for exactly that reason. The gate runs
`dist/cli/index.js` for real and asserts on what it emits, including that
misuse exits 2 — a dispatcher bug shows up as accepting bad input rather than
as wrong output.

## Project layout

```
src/                    Library source
  blueprint.ts          Blueprint<C, E, I, A> + defineBlueprint
  binding.ts            Binding<B> + bind + type extractors
  environment.ts        Environment + createEnvironment (reserved-name validation)
  protocol.ts           Protocol union + HttpRouteMap + createHttpClient
  interface.ts          Interface<P> + iface() + ApiFromInterface
  helpers.ts            HelperContext + http helper
  events.ts             Typed EventCatalog + per-component EventBus
  probe.ts              Probe<I> + runProbe
  adapter.ts            Adapter SPI (7 required + optional reconnect) + StartSpec
  metadata.ts           Cross-process JSON snapshot schema
  orchestrator.ts       startEnvironment / attachEnvironment + chaos
  observer.ts           Framework lifecycle event stream (D-024)
  reporter.ts           createConsoleReporter — built-in stream consumer
  runtime.ts            Runtime<E> + ChaosControls<E>
  shared.ts             createSharedEnvs — atomic file claim
  invariants.ts         invariant() — cross-module agreements, off for consumers (D-042)
  compose.ts            reconcileComposeStack + FingerprintSpec (D-031)
  adapters/
    docker.ts           dockerode + SIGINT cleanup; onImageDrift policy (D-028)
    memory.ts           Factory-registry in-process adapter
    kubernetes.ts       K8s adapter (deploy + attach modes), reconnection layer
    kubectl.ts          kubectl subprocess wrapper (D-019)
    composite.ts        Routes components/instances to different substrates (D-038)
  cli/
    index.ts            cyanotype derive CLI dispatch (bin entry) (D-030)
    derive.ts           deriveCompose / deriveK8s / loadDerivedCompose (D-030, D-032)
  index.ts              Public surface (.d.ts emitted by tsc at build)

tests/
  preload.ts            bun:test global setup + teardown (afterAll → shared.stopAll)
  core/                 Harness self-tests — pure, no daemon or cluster
  substrate/            Adapter integration against real Docker and Kubernetes
  fakes/                Reusable in-process simulators for Blueprints
  petstore-example/     End-to-end SLA suite (runs across all five adapters)
  support/require-substrate.ts  Availability probes + CYANOTYPE_REQUIRE_* (skip vs fail)
  support/images.json   Upstream images, their GHCR mirror, and recorded ids
  support/containers/   Dockerfiles for the test images
  support/k8s/
    petstore-attach/    K8s manifests for the k8s-attach fixture topology
  support/compose/
    petstore-attach/    Docker Compose stack for the docker-attach fixture topology

docs/
  axioms.md             The seven forces — contract-derived constraints
  decisions.md          Architecture decision records
  design.md             Architecture map, concept relationships, type flows
  attach-mode.md        Walkthrough for attach mode against K8s clusters and Docker Compose stacks
  k8s-rbac.md           RBAC requirements + cluster setup for the K8s adapter

scripts/                Repository tooling. Gates are silent on success and print
                        the whole story between two [GATE] lines on failure.
  pre-release.ts        Gate: is this tree releasable? (superset of CI)
  check-no-leaks.ts     Gate: no Cyanotype containers survived the suite
  prime-images.ts       Gate: upstream images present, pulled from the mirror
  k8s-load-images.ts    Gate: the cluster can see the built images
  kind-up.ts            Create the standard kind cluster; waits for DNS
  mirror-images.ts      Copy upstream images to GHCR; run by the monthly workflow
  attach-suite.ts       Run the example against a pre-deployed stack, tear it down
  hints.ts              Render every error, its trigger, and its hint

.github/workflows/
  ci.yml                Three jobs on every PR: unit, docker, kubernetes
  release.yml           Publishes to npm on a v*.*.* tag (Trusted Publishers)
  mirror-images.yml     Monthly image refresh; opens a PR rather than pushing

bunfig.toml             Registers tests/preload.ts as the test preload
CONVENTIONS.md          Coding discipline (read before writing code)
CONTRIBUTING.md         You are here
AGENTS.md               Slim brief for AI coding agents (a subset of the above + hard rules)
README.md               Marketing / usage intro
```

## License

MIT — see [`LICENSE`](./LICENSE). Contributions are accepted under the same license.
