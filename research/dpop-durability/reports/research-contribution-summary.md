# Research contribution summary

## Problem and intended novelty

DPoP proof single-use depends on replay state being shared and retained through the proof-acceptance window. Backend failure may remove state that a client believed had been accepted. The intended contribution is empirical characterization linking acknowledgement semantics, replay acceptance, recovery, and performance in replicated microservices. No universal priority claim is made.

## Demonstrated contributions

- An isolated DPoP proof/token verifier using maintained JOSE/JWT software, with signature, key-binding, `ath`, `htm`, `htu`, time, authorization, and replay checks.
- Process-local and standalone Redis controls plus two-node Redis primary/replica experiments for primary-only reply, WAIT, insufficient WAIT, and WAITAOF.
- Same-connection Redis acknowledgement commands, measured acknowledgement counts, fail-closed handling when the required count is not met, controlled replication-link detach, primary SIGKILL, and manual replica promotion.
- Three validated main run directories: 10 repetitions for each standalone condition and five for each replicated condition. Eleven failed, pilot, or invalid-design runs remain documented and excluded.
- In this testbed, primary-only writes were lost in 15/15 standalone/replicated-primary-only observations. The promoted replica retained state in 5/5 WAIT-acknowledged and 5/5 WAITAOF-acknowledged observations. WAIT-insufficient failed closed in 5/5, then accepted the proof after promotion without duplicate operation execution.

## Research-question answers

- **RQ1:** The tested shared Redis controls rejected normal replay. Process-memory reset, volatile standalone restart, and replicated primary-only promotion allowed replay in all observed attempts. WAIT and WAITAOF conditions rejected replay after the manual promotion in all five repetitions each. These results are specific to the tested one-replica, same-host setup.
- **RQ2:** Primary-only acknowledged-write loss occurred in 15/15 tested crash/promotion attempts. No loss was observed in 5/5 WAIT and 5/5 WAITAOF promotion attempts. WAIT returning zero failed closed, and that unacknowledged write is not classified as acknowledged loss.
- **RQ3:** Descriptive latency and recovery measures are in the tables. The study does not measure throughput, live outage availability, controlled CPU use, or causal/statistical performance differences.

## Strongest empirical finding

After primary-only SET replies, replay state was absent from the promoted replica in 5/5 two-node runs where the replica link was verified down before the write. The same proof was accepted after promotion. After WAIT 1 and WAITAOF local-plus-replica acknowledgements, replay was rejected in 5/5 runs per policy. Wilson intervals remain wide (5/5: 56.6–100%; 0/5: 0–43.4%). This does not establish strong consistency or universal durability.

## Limitations and claims that cannot be made

The two Redis containers shared one host, kernel, and storage; promotion was manual, not Sentinel/Cluster. There was no multi-host partition, MySQL, three resource-service replicas, production HTTP/TLS service, sustained throughput, or live outage availability test. Sample sizes are small and no significance claims are warranted. One completed experiment with incorrect fault ordering and all pilot/failed attempts were excluded with reasons. No Redis backend is characterized as inherently secure or insecure.

## Next research step

Move the primary/replica and resource services to independent failure domains, add Sentinel or Redis Cluster automated promotion, controlled replication lag and partitions, and compare MySQL InnoDB. Add live request availability and sustained throughput under equal workloads, increase independent repetitions based on precision goals, and preserve this dataset as a single-host baseline.
