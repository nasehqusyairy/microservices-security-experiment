| Scenario | n runs | Replay accepted | Replay detections | Ack write loss | Duplicate operation executions | Valid first-use success | p50 / p95 / p99 local latency (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| memory_normal | 15 | 0/15 (0%) | 15/15 | 0/15 | 0 | 15/15 | 0.525 / 2.094 / 3.158 |
| memory_process_restart | 15 | 15/15 (100%) | 0/15 | 0/15 | 15 | 15/15 | 0.436 / 0.865 / 1.012 |
| redis_normal_cross_instance | 15 | 0/15 (0%) | 15/15 | 0/15 | 0 | 15/15 | 0.675 / 1.618 / 1.832 |
| redis_primary_sigkill | 15 | 15/15 (100%) | 0/15 | 15/15 | 15 | 15/15 | 0.794 / 2.251 / 2.409 |
| primary_only_detached | 10 | 10/10 (100%) | 0/10 | 10/10 | 10 | 10/10 | 0.832 / 1.634 / 2.438 |
| wait_replica_acked | 10 | 0/10 (0%) | 10/10 | 0/10 | 0 | 10/10 | 1.107 / 2.049 / 3.152 |
| wait_ack_insufficient | 10 | 10/10 (100%) | 0/10 | 0/10 | 0 | 0/10 | 126.744 / 336.681 / 337.148 |
| waitaof_local_replica_acked | 10 | 0/10 (0%) | 10/10 | 0/10 | 0 | 10/10 | 11.213 / 208.072 / 245.242 |
