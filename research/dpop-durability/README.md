# DPoP replay-state durability experiment

This isolated research path preserves the repository's JWT experiment. The verifier uses maintained `jose` software for ES256 signatures, JWK thumbprints, JWT access tokens, and token hashing.

From repository root:

```bash
npm ci --prefix research/dpop-durability
npm test --prefix research/dpop-durability
DPOP_TOKEN_SECRET='replace-with-a-unique-32-character-test-secret' npm run serve --prefix research/dpop-durability
npm run client --prefix research/dpop-durability -- http://127.0.0.1:3000
npm run experiment --prefix research/dpop-durability
npm run experiment:replicated --prefix research/dpop-durability
python3 -m venv research/dpop-durability/.venv
research/dpop-durability/.venv/bin/pip install -r research/dpop-durability/requirements-analysis.txt
research/dpop-durability/.venv/bin/python research/dpop-durability/scripts/analyze.py
```

The standalone runner tests process memory and one volatile Redis server through restart. The replicated runner starts two Redis 7.4.12 containers per condition and tests primary-only reply, WAIT, insufficient WAIT, and WAITAOF with manual replica promotion. Both use an exact Redis image digest, isolated containers/networks, per-container CPU/memory limits, loopback ephemeral ports, unique output folders, and clean up only resources they created. `DPOP_REPETITIONS` and `DPOP_OUTPUT` can override repetition count and output location. The default is five repetitions. `docker-compose.replicated.yml` provides an optional static two-node fixture; the experiment runners use dynamic Docker networks/ports instead.

The HTTP research service exposes `POST /token`, `POST /orders`, and `GET /health`; the experiment client performs the token/proof flow. The token endpoint intentionally has no OAuth grant or user-authentication step and is only for local functional experiments. The actual durability datasets call the same verifier directly in-process, not the HTTP service. Use a unique throwaway secret. Set `REDIS_URL` to use the Redis replay store; otherwise the server uses process-local memory.

WAIT is sent on the same connection as its SET and the actual returned replica count is checked. WAITAOF is configured with AOF and `appendfsync always` on both nodes, and both local/replica counts are checked. Redis documents that WAIT improves failover safety but does not provide strong consistency ([WAIT](https://redis.io/docs/latest/commands/wait/)); WAITAOF is documented [here](https://redis.io/docs/latest/commands/waitaof/). The replication test is same-host with manual promotion, not Sentinel/Cluster. Docker network detachment interrupts the replica link; it is not reported as a network partition.

The verifier checks the DPoP ES256 proof signature and public JWK; `typ`, `jti`, `iat`, `htm`, normalized `htu`, `ath`, DPoP authorization, token issuer/audience/expiry, and `cnf.jkt`. Replay state is consumed only after validation. Insufficient acknowledgements and store errors fail closed. The profile has no OAuth grant validation, nonce/refresh flows, proxy trust rules, or TLS. DPoP does not replace TLS.

Three main run directories pass automated validation. Failed pilots and the invalid-order run remain preserved and excluded with reasons in the generated exclusion log. Tables, figures, and validation are regenerated from the included raw data by `scripts/analyze.py`. See `audit/` and `reports/` for environment, protocol limits, and evidence-based conclusions.
