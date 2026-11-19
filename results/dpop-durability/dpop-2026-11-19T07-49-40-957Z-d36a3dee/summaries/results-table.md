| Scenario | n runs | Replay accepted | Replay detections | Ack write loss | Duplicate operation executions | Valid first-use success | p50 / p95 / p99 local latency (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| memory_normal | 5 | 0/5 (0%) | 5/5 | 0/5 | 0 | 5/5 | 0.496 / 2.059 / 2.059 |
| memory_process_restart | 5 | 5/5 (100%) | 0/5 | 0/5 | 5 | 5/5 | 0.444 / 0.766 / 0.766 |
| redis_normal_cross_instance | 5 | 0/5 (0%) | 5/5 | 0/5 | 0 | 5/5 | 0.644 / 1.024 / 1.024 |
| redis_primary_sigkill | 5 | 5/5 (100%) | 0/5 | 5/5 | 5 | 5/5 | 0.827 / 2.409 / 2.409 |
