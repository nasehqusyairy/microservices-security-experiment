| Scenario | n runs | Replay accepted | Replay detections | Ack write loss | Duplicate operation executions | Valid first-use success | p50 / p95 / p99 local latency (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| memory_normal | 10 | 0/10 (0%) | 10/10 | 0/10 | 0 | 10/10 | 0.511 / 2.059 / 3.158 |
| memory_process_restart | 10 | 10/10 (100%) | 0/10 | 0/10 | 10 | 10/10 | 0.434 / 0.865 / 1.012 |
| redis_normal_cross_instance | 10 | 0/10 (0%) | 10/10 | 0/10 | 0 | 10/10 | 0.631 / 1.319 / 1.832 |
| redis_primary_sigkill | 10 | 10/10 (100%) | 0/10 | 10/10 | 10 | 10/10 | 0.804 / 2.251 / 2.409 |
| primary_only_detached | 5 | 5/5 (100%) | 0/5 | 5/5 | 5 | 5/5 | 0.763 / 2.438 / 2.438 |
| wait_replica_acked | 5 | 0/5 (0%) | 5/5 | 0/5 | 0 | 5/5 | 0.924 / 2.049 / 2.049 |
| wait_ack_insufficient | 5 | 5/5 (100%) | 0/5 | 0/5 | 0 | 0/5 | 126.728 / 336.681 / 336.681 |
| waitaof_local_replica_acked | 5 | 0/5 (0%) | 5/5 | 0/5 | 0 | 5/5 | 10.379 / 208.072 / 208.072 |
