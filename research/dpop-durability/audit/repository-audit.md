# Repository audit

Audit date: 2026-11-19 UTC. Base revision: `5ab4b4f5cbdbc8e36216075615f941b9748253ef`.

The repository is a Node.js/Express microservice security testbed. Its existing replay experiment is JWT based: `run-local-demo-2.js`, `order-service/replay-auth.js`, and `order-service/replay-stores.js` enforce JWT signature/issuer/audience/expiry/JTI validation and consume replay state in memory, Redis SET NX, Redis SET NX PX, or MySQL InnoDB. It has scenario/request/event logging, concurrency helpers, tests, an analysis script, notebooks, and 28 historical run directories under `results/`. These files and datasets remain unmodified.

No DPoP proof, key-binding, `ath`, `htm`, or `htu` verifier existed in the baseline. The existing store interface can inform the new path, but the JWT middleware is not reusable as a DPoP verifier. Existing MySQL and Redis containers were healthy and active at audit time; they are shared by this workspace and were left untouched. The DPoP runner creates a disposable, uniquely named Redis container with a dynamically allocated loopback port and resource limits.

## Findings

| Area | Existing state | DPoP work |
| --- | --- | --- |
| JWT auth and protected operation | Present in auth, gateway, and order services | Kept isolated; a DPoP-specific verification library and protected-operation decision were added |
| Replay interface | In-memory, Redis, Redis TTL, MySQL | New explicit FIRST_USE / REPLAY / STORE_ERROR semantics for in-memory and Redis only |
| Redis durability/failover | Existing JWT experiment uses standalone Redis; no preexisting DPoP topology | New isolated single-node crash and two-node primary/replica tests for primary reply, WAIT, WAIT-insufficient, and WAITAOF with manual promotion |
| MySQL durability | Existing JWT experiment uses InnoDB; no DPoP path | Not implemented or compared in this experiment |
| Fault injection | Existing runner has process restart/concurrency behavior, not DPoP durability faults | DPoP runner SIGKILLs its own isolated Redis after the SET reply and restarts it |
| Analysis/results | JWT datasets and notebooks exist | Separate DPoP result root and DPoP scripts/reports |

## Reuse decisions

- Preserve all JWT implementation, configuration, result directories, and analysis artifacts unchanged.
- Reuse the repository's local Node.js toolchain and its append-only, per-run experiment directory convention.
- Use the maintained `jose` library for JWS, JWT, JWK, and thumbprint operations. Use the maintained Redis Node client for atomic SET NX.
- Do not route DPoP traffic through the JWT services because that would test the wrong protocol and could alter baseline behavior.

## Gaps and constraints

The available environment is one Linux host with Docker and no local Redis server executable. Existing Redis/MySQL services are not safe fault-injection targets, so the DPoP experiments create limited, project-specific containers. A two-node same-host replication topology was feasible; independent hosts, Sentinel/Cluster automation, MySQL DPoP experiments, production HTTP/TLS, and live client-visible outage availability remain outside the measured scope.

## Status

Completed the focused DPoP verifier and a limited matrix with 10 standalone repetitions and five repetitions per replicated Redis condition. Three main run directories validate; eleven failed, pilot, or invalid-design attempts are excluded with reasons. Results are a bounded characterization of this same-host testbed and manual-promotion failure model, not a general result about replicated backends.
