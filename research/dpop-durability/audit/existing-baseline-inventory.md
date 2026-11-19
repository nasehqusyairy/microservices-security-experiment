# Existing JWT baseline inventory

The separate historical baseline includes:

- `auth-service/server-secure.js` and `server-vulnerable.js`: token issuance and deliberately vulnerable demonstration paths.
- `gateway/server.js`: JWT validation/proxy path.
- `order-service/server-secure.js`, `replay-auth.js`, and `replay-stores.js`: protected order operation and in-memory, Redis, Redis TTL, and MySQL replay stores.
- `run-local-demo-2.js`, `experiment-concurrency.js`, and `experiment-logging.js`: data-oriented experiment orchestration, concurrency, and event logging.
- `order-service/test/`: replay-store integration and experiment tests.
- `analysis/analyze_replay_protection.py` and six Jupyter notebooks: JWT experiment validation and analysis.
- 28 directories below `results/` at audit; run outputs contain metadata, scenario/request/summary CSV, JSONL events, and varying analysis artifacts.

The current branch starts at the recorded baseline commit, and no baseline file is changed by the DPoP experiment. Historical data were not recomputed or silently imported as DPoP evidence.
