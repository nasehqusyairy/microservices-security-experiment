# Results and discussion draft: DPoP replay-state durability

## Status and scope

This is a validated but bounded single-host study. It includes standalone Redis and a two-node primary/replica topology with manual promotion. It does not claim production failover behavior. Three main run directories pass validation. Eleven failed, pilot, or invalid-design attempts remain preserved and are listed in the exclusion log.

## Experimental environment

One x86-64 Ubuntu 26.04.1 host (8 logical CPUs, 14 GiB RAM) ran Node.js 26.7.0, Docker Engine 29.8.1, and Redis 7.4.12, image digest `redis@sha256:7b1753b4c5ad8458906c272a8132b8c15f5557b000379eb115fb239706a384b7`. Standalone runs used one Redis container limited to 256 MiB/0.5 CPU, with RDB and AOF disabled. Replicated runs used isolated primary and replica containers limited to 128 MiB/0.25 CPU each. Both containers shared the same host, kernel, and storage. Existing shared Redis/MySQL services were not changed.

The main durability runners invoked the verifier in the Node process and called the Redis client directly; they did not use an HTTP server or TLS. A separate loopback HTTP token/resource server and client exist and are covered by integration tests, but were not used for durability measurements. Two replay-store instances sharing Redis model separate resource instances for the cross-instance check, but are not separate resource-server processes. Reported request latency is local verifier-plus-store latency, not service end-to-end latency.

## Experimental design

Two complete standalone invocations provide 10 repetitions for each of four controls. One replicated-topology invocation provides five repetitions for each of four Redis acknowledgement conditions. Each repetition uses a new key, token, JTI, and replay-store namespace, then sends a first use and a replay/failover request. Repetition order was randomized for the replicated experiment. The standalone run order was randomized by the runner.

The eight conditions are: (1) normal process memory; (2) process-memory reset; (3) shared standalone Redis cross-instance replay; (4) standalone volatile Redis primary reply then SIGKILL/restart; (5) two-node Redis with the replica link verified down before a primary-only write, then primary SIGKILL and manual promotion; (6) two-node Redis SET followed by `WAIT 1 1500` on the same connection, then SIGKILL/promotion; (7) detached replica and `WAIT 1 250`, which returned zero and caused fail-closed rejection, then SIGKILL/promotion; and (8) AOF enabled with `appendfsync always` on both nodes, followed by same-connection `WAITAOF 1 1 2000`, SIGKILL, and promotion.

The primary-only reply provides no replica or fsync acknowledgement. WAIT is issued on the same connection as the preceding SET, and the returned replica count is checked. Redis documents that WAIT improves failover safety but does not make Redis strongly consistent or rule out loss of synchronously replicated writes ([Redis WAIT documentation](https://redis.io/docs/latest/commands/wait/)). WAITAOF local and replica results are separately checked; the command is available from Redis 7.2 ([Redis WAITAOF documentation](https://redis.io/docs/latest/commands/waitaof/)).

For acknowledged-write loss, the first operation must have been accepted with the specified acknowledgement, followed by the recorded fault, recovery/promotion, and acceptance of the same proof. In the replicated test, the replica role and `master_link_status:down` were verified before primary-only writes. Docker network detachment interrupted the replica link; the study does not call it a network partition. The promotion was manual via `REPLICAOF NO ONE`, not Sentinel or Redis Cluster failover.

## Dataset and validation

The main data contain 120 measured verifier calls: 80 across two standalone runs and 40 across one replicated run. Standalone conditions have 10 repetitions each; replicated conditions have five. JTI values are SHA-256 hashed for correlation; access tokens and private keys are never logged.

Automated validation checked required schema fields, request and run identifiers, metadata and row counts, first-use/replay pairing, JTI correlation, acknowledgement counts, protected-operation execution, backend health, fault and recovery ordering, replay result, and reconstructed acknowledged-write loss. Three main run directories passed. Eleven attempts were excluded: incomplete early standalone/replication runs, two one-repetition pilots, and one complete replicated run with incorrect promotion-before-crash ordering. Reasons are in `invalid-run-exclusion-log.csv`. Empty acknowledgement fields in the first standalone run are normalized to `not_applicable` only in analysis memory; raw data were not rewritten.

## Results for RQ1

**RQ1: To what extent do configurations preserve proof single-use under backend failures and recovery?** Normal memory and shared standalone Redis rejected replay in 10/10 repetitions each. Replay was accepted after memory reset (10/10) and volatile standalone Redis restart (10/10); both conditions produced 10 duplicate protected-operation executions.

In two-node Redis, replay was accepted after a primary-only write with the replica link down in 5/5 repetitions. After successful WAIT replica acknowledgement, replay was rejected in 5/5. After successful local-plus-replica WAITAOF acknowledgement, replay was rejected in 5/5. When WAIT returned zero, the initial request failed closed in 5/5; the proof was accepted after promotion in 5/5, but the protected operation executed only once because the initial attempt was rejected. Thus these five observations do not show duplicate operation execution for the insufficient-ack condition.

The evidence supports a bounded finding: in this same-host topology, observed primary-only writes were absent from the promoted replica, while the tested WAIT and WAITAOF acknowledgements corresponded to retained state after manual promotion. It does not establish a guarantee for other failure timing, automated promotion, or multiple replicas.

## Results for RQ2

**RQ2: How do durability mechanisms affect acknowledged-write loss and subsequent replay acceptance?** Primary-only acknowledged-write loss was 10/10 in the standalone crash condition and 5/5 in the replicated primary-only condition (15/15 combined for those configurations). The operational evidence is successful re-consumption and protected-operation execution after recovery; the experiment did not separately query Redis keyspace before replay. No post-promotion acknowledged-write loss was observed after WAIT (0/5) or WAITAOF (0/5). WAIT returned zero in the insufficient-ack condition (5/5); those requests failed closed and are not counted as acknowledged-write loss.

## Results for RQ3

**RQ3: What are the security, performance, and availability trade-offs?** Replay acceptance and latency by condition appear in `results-table.csv`. Median verifier-plus-store latency was 0.924 ms for WAIT success and 10.379 ms for WAITAOF; nearest-rank p95/p99 were 2.049/2.049 ms and 208.072/208.072 ms, respectively (10 request observations per condition). WAIT-insufficient had a median of 126.728 ms and p95/p99 of 336.681 ms, reflecting the configured wait and a replay call. The standalone medians were 0.511 ms (normal memory), 0.434 ms (memory reset), 0.631 ms (shared Redis), and 0.804 ms (standalone crash); see the table for p95/p99.

These are descriptive measurements from two operations in each repetition. AOF/fsync latency varied considerably between repetitions; one WAITAOF run group had a large tail. No sustained throughput test, warm-up protocol, inferential comparison, or causal latency claim is made. All first uses succeeded in seven conditions (5/5 or 10/10); WAIT-insufficient failed closed in 5/5. Live HTTP outage availability and client-facing service interruption were not measured.

Fault-to-backend-health medians were 269.1 ms (249.9–276.8, n=10) for standalone Redis restart; replicated manual-promotion medians were 197.4 ms (196.6–211.6) for primary-only, 131.2 ms (128.6–5156.8) for WAIT, 213.5 ms (199.2–221.3) for WAIT-insufficient, and 130.0 ms (125.0–138.9) for WAITAOF, each n=5. The WAIT condition had one long recovery tail. These local timings include Docker control and health probing.

Replay-rate 95% Wilson intervals using repetitions as the unit are: 0/10, 0–27.8%; 10/10, 72.2–100%; 0/5, 0–43.4%; and 5/5, 56.6–100%. These intervals are wide. The results do not establish population probabilities or statistical significance.

## Security analysis

The focused verifier uses `jose` for ES256 signatures, public JWK import/export and thumbprints, access-token validation, and SHA-256. It checks `typ`, asymmetric `alg`, public-only `jwk`, proof signature, `jti`, `iat` age/skew, `htm`, `htu` without query/fragment, `ath`, DPoP authorization, JWT issuer/audience/expiry, and `cnf.jkt`. Replay state is consumed only after proof/token validation; backend and insufficient-ack errors fail closed. Fourteen automated tests cover protocol checks, replay, malformed traffic, store errors, concurrency, WAIT/WAITAOF acknowledgement handling, and the HTTP token/resource flow.

This is not a complete OAuth authorization/resource server: the local `/token` endpoint issues test tokens without an authorization grant or user authentication. There is no nonce negotiation, refresh-token flow, proxy-trust policy, or TLS. The HTTP resource server rejects duplicate DPoP headers, but durability measurements call the verifier directly. DPoP does not replace transport security.

## Performance, recovery, and trade-off interpretation

The test demonstrates the difference between a primary reply, a replica acknowledgement, and local/replica AOF acknowledgements for the tested manual failover. Atomic SET NX blocks replay while state remains available; it does not make the state durable by itself. The measured latency and recovery costs cannot be generalized to production, different storage devices, or automated topologies. Redis documentation itself warns that WAIT is not strong consistency; the observed WAIT result should be read as evidence for this specific tested promotion only.

No throughput or controlled CPU-utilization comparison was performed. Host load average and runner RSS are logged as context, not CPU or backend memory utilization. MySQL, WAITAOF timeout, live backend outage handling, and a separate resource-service replica deployment were not tested.

## Unexpected outcomes and limitations

The WAIT-insufficient condition allowed the proof after promotion but did not duplicate the operation because its first attempt had failed closed. WAITAOF latency varied, including a long tail in the first complete measurement batch. Eleven attempts were excluded for implementation/fault-ordering issues or pilot policy; they remain documented and were not pooled.

The study uses one host, shared kernel/storage, manual promotion, two Redis nodes, and a small sample. It does not test Sentinel/Cluster, three resource-server replicas, independent failure domains, a real network partition, MySQL, production HTTP/TLS, sustained load, throughput, or service availability. Process-local restart is modeled by reconstructing its store in the runner rather than killing a separate resource-service process. The JWT access token is experimental. TTL is 360 seconds against a 300-second proof-age limit plus 30-second future skew.

## Practical implications

State atomicity and state durability are separate properties. In this test, primary-only replies did not survive the specified promotion, while the tested WAIT and WAITAOF policies did. Those observations justify naming acknowledgement semantics and recovery procedure in any claim; they do not recommend one policy universally.

## Reproducibility

From repository root:

```bash
npm ci --prefix research/dpop-durability
npm test --prefix research/dpop-durability
npm run experiment --prefix research/dpop-durability
npm run experiment:replicated --prefix research/dpop-durability
python3 -m venv research/dpop-durability/.venv
research/dpop-durability/.venv/bin/pip install -r research/dpop-durability/requirements-analysis.txt
research/dpop-durability/.venv/bin/python research/dpop-durability/scripts/analyze.py
```

Both runners use a pinned Redis image digest, isolated networks/containers, resource limits, dynamic loopback ports, unique results directories, and remove only resources they create. Do not point these destructive fault tests at an existing Redis service.
