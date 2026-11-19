# Adapted implementation plan and status

1. Freeze baseline and create `research/dpop-durability`. **Done.**
2. Add isolated standards-oriented proof/key/token verification, with tests. **Done for the tested verifier profile; see protocol deviations.**
3. Add replay state with explicit first-use/replay/store-error/insufficient-ack/timeout results. **Done for process memory, Redis SET NX, WAIT, and WAITAOF.**
4. Add isolated Redis failure/recovery experiments. **Done for standalone volatile restart and two-node primary/replica primary-only, WAIT, WAIT-insufficient, and WAITAOF conditions, with five repetitions each.**
5. Validate raw records and reconstruct metrics; preserve failed pilots. **Done: 3 main run directories pass validation; 11 failed/pilot/invalid-design attempts are recorded in the exclusion log.**
6. Produce actual-data figures, result tables, and research discussion. **Done for metrics supported by the bounded experiment; unsupported comparisons are explicitly marked not measured.**
7. Reproduce representative invocations and audit claims. **Done: two standalone 5-repetition runs and one replicated 5-repetition run completed using the documented commands.**

MySQL, Sentinel/Cluster automatic failover, three resource-service processes, and multi-host/network-partition configurations remain unexecuted. The replicated Redis tests use one replica on the same host and manual promotion; they are not substituted for those conditions.
