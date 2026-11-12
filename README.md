# Microservices Security Research
## Securing Inter-Service Communication in Containerised Microservice Architectures

This repository contains the complete implementation for the research paper:
**"Securing Inter-Service Communication in Containerised Microservice Architectures: A Comprehensive Practical and Experimental Study"**

---

## Project Structure

```
microservices-security/
├── auth-service/
│   ├── server-vulnerable.js     # Phase 1: No security controls
│   ├── server-secure.js         # Phase 2: Full hardening
│   ├── package.json
│   └── Dockerfile
│
├── order-service/
│   ├── server-vulnerable.js     # Phase 1: Weak JWT validation
│   ├── server-secure.js         # Phase 2: Strict validation + mTLS
│   ├── package.json
│   └── Dockerfile
│
├── gateway/
│   ├── server.js                # API Gateway with centralized auth
│   ├── package.json
│   └── Dockerfile
│
├── attacker/
│   ├── attack1-token-forgery.js    # Forges JWT using hardcoded secret
│   ├── attack2-brute-force.js      # Automated credential guessing
│   ├── attack3-replay.js           # Token replay exploitation
│   ├── attack4-weak-validation.js  # JWT claim manipulation
│   └── run-all-attacks.js          # Runs all attacks
│
├── certs/
│   └── generate-certs.sh        # Generates CA + mTLS certificates
│
├── nginx/
│   └── nginx.conf               # HTTPS reverse proxy config
│
├── attacks.ps1                  # PowerShell attack scripts (from paper)
├── run-local-demo.js            # Full demo without Docker
├── docker-compose.vulnerable.yml
├── docker-compose.secure.yml
└── README.md
```

---

## Quick Start (No Docker Required)

### 1. Install dependencies
```bash
npm run install:all
```

### 2. Generate mTLS certificates
```bash
npm run certs
```

### 3. Run the full demo
```bash
node run-local-demo.js
```

This will:
1. Start all services in **vulnerable** mode
2. Execute all 4 attack demonstrations
3. Restart services in **secure** mode
4. Re-run attacks showing mitigations in action

---

## Docker Deployment

### Phase 1: Vulnerable System
```bash
docker-compose -f docker-compose.vulnerable.yml up --build
```

### Phase 2: Secure System
```bash
# First generate mTLS certificates
bash certs/generate-certs.sh

# Start secure stack
docker-compose -f docker-compose.secure.yml up --build
```

---

## Running Individual Attacks

Make sure services are running first, then:

```bash
# Token Forgery
node attacker/attack1-token-forgery.js

# Brute-Force
node attacker/attack2-brute-force.js

# Replay Attack
node attacker/attack3-replay.js

# Weak Validation
node attacker/attack4-weak-validation.js

# All attacks
node attacker/run-all-attacks.js
```

### PowerShell (Windows - as in the paper)
```powershell
# Import the attack module
. .\attacks.ps1

# Run individual attacks
Attack-TokenForgery
Attack-BruteForce
Attack-Replay -Token "<captured_jwt>"
Run-AllAttacks
```

---

## Service Endpoints

| Service        | Port | Endpoint           | Description              |
|---------------|------|--------------------|--------------------------|
| Auth Service  | 3000 | POST /service-token | Get JWT token            |
| Auth Service  | 3000 | GET /health         | Health check             |
| Order Service | 4000 | GET /orders         | Protected endpoint       |
| Order Service | 4000 | GET /health         | Health check             |
| API Gateway   | 5000 | GET /orders         | Proxied through gateway  |
| API Gateway   | 5000 | POST /auth/service-token | Via gateway        |
| Nginx         | 443  | (all routes)        | HTTPS termination        |

---

## Vulnerabilities Demonstrated

| # | Attack           | Root Cause                          | Mitigation                          |
|---|-----------------|-------------------------------------|--------------------------------------|
| 1 | Token Forgery   | Hardcoded JWT secret in source code | Environment variable secrets         |
| 2 | Brute Force     | No rate limiting on auth endpoint   | `express-rate-limit` (3 req/min)     |
| 3 | Replay Attack   | No token tracking, no expiration    | Token Set tracking + 60s expiry      |
| 4 | Weak Validation | Signature-only JWT verification     | Issuer + audience + identity checks  |
| 5 | MITM            | Plain HTTP communication            | HTTPS via Nginx + mTLS               |

---

## Security Framework Layers

1. **JWT Hardening** — env secrets, expiration, issuer, audience
2. **Secret Management** — Docker environment variables
3. **Rate Limiting** — express-rate-limit on `/service-token`
4. **Token Binding** — replay protection via in-memory token store
5. **API Gateway** — centralized authentication enforcement
6. **HTTPS** — Nginx TLS termination
7. **mTLS** — mutual certificate authentication between services
8. **Zero-Trust** — never trust, always verify

---

## Technology Stack

| Component       | Technology                     |
|----------------|-------------------------------|
| Backend         | Node.js + Express.js          |
| Authentication  | JSON Web Tokens (JWT)         |
| Containers      | Docker + Docker Compose       |
| API Gateway     | Express + http-proxy-middleware|
| TLS             | OpenSSL + HTTPS + mTLS        |
| Reverse Proxy   | Nginx                         |
| Testing         | Node.js scripts + PowerShell  |

---

## Expected Results

### Vulnerable Phase Output
```
ATTACK 1: Forged token accepted → HTTP 200 (VULNERABLE)
ATTACK 2: FOUND SECRET: order_secret
ATTACK 3: Replay 1: ACCEPTED | Replay 2: ACCEPTED | Replay 3: ACCEPTED
ATTACK 4: Manipulated claims accepted → HTTP 200 (VULNERABLE)
```

### Secure Phase Output
```
ATTACK 1: Forged token rejected → HTTP 401 Invalid token (SECURE)
ATTACK 2: Rate limited → HTTP 429 Too many requests (SECURE)
ATTACK 3: Replay 1: OK | Replay 2: BLOCKED Token already used (SECURE)
ATTACK 4: Manipulated claims rejected → HTTP 403 Forbidden (SECURE)
```

---

## References

- NIST SP 800-207: Zero Trust Architecture
- JWT RFC 7519
- Docker Documentation
- express-rate-limit Documentation
- OpenSSL Documentation

---

## Replay Protection Experiment

`run-local-demo-2.js` is a separate, data-oriented experiment runner. It leaves
the original vulnerable/secure demonstration in `run-local-demo.js` unchanged.
The experimental path is **Auth Service → Client/Runner → API Gateway → Order
Service**; the gateway verifies JWTs and calls the Order Service over mTLS.

The experiment uses one-time-use service tokens: a valid JWT `jti` can authorize
the protected `/orders` operation once. Each token has a cryptographically
random `jti`, `sub`, `iat`, `exp`, issuer, and audience. This is an explicit
measurement assumption, not a recommendation to reject normal access tokens
reused for separate legitimate operations in a production API.

### Replay stores

The secure Order Service selects one shared `consume(jti, expiresAt)` interface
using `REPLAY_METHOD`:

| Method | Behavior |
|---|---|
| `in-memory` | Process-local Set; atomically accepts a `jti` once, but replicas and restarts have independent/empty state. |
| `redis` | Atomic Redis `SET NX`; shared across replicas and retained without expiry for the experiment. |
| `redis-ttl` | Atomic Redis `SET NX PX`; entry TTL is the JWT's remaining lifetime. |
| `mariadb` | Shared MariaDB InnoDB table accessed with the `mysql2/promise` driver, using atomic `INSERT ... VALUES (...)` on a SHA-256 `jti_hash` primary key; duplicate inserts are classified as replay detection and DB failures as `store_error`. |

JWT signature, issuer, audience, service identity, expiry, and `jti` validation
are the same for all methods and happen before replay-store lookup. Redis
failures reject requests with HTTP 503 (fail closed) and are recorded as
`store_error`, not as detected replays. Redis keys contain a SHA-256 digest of
the `jti`. The experimental token-provisioning route is available only when
`EXPERIMENT_MODE=true`, from loopback, and with a per-run key; ordinary
`/service-token` behavior and rate limiting remain intact.

### Scenario matrix

| Scenario | Method | Order replicas |
|---|---|---:|
| S1 | in-memory | 1 |
| S2 | redis | 1 |
| S3 | redis-ttl | 1 |
| S4 | mariadb | 1 |
| S5 | in-memory | 2 |
| S6 | redis | 2 |
| S7 | redis-ttl | 2 |
| S8 | mariadb | 2 |
| S9 | in-memory | 3 |
| S10 | redis | 3 |
| S11 | redis-ttl | 3 |
| S12 | mariadb | 3 |

Each repetition starts clean Order Service processes and uses a unique Redis
key prefix. Requests are routed by replica ID through an experiment-only
gateway selector and the actual receiving replica is logged and checked.
Scenarios with two or three replicas include a first use and a replay at
different replicas. Concurrent batches record request IDs and the requested
and observed request distribution for every replica. In-memory concurrency is
validated per replica; Redis and MariaDB concurrency is validated globally.
Each run also measures replay state after restarting `order-1`.

### Run the experiment

Install dependencies and generate the local mTLS certificates:

```bash
npm run install:all
npm run certs
```

Start the shared experiment dependencies. The Compose file keeps the previous
MariaDB volume intact and uses a dedicated experiment database on host port
3308, avoiding collision with a locally installed database on port 3306:

```bash
docker compose -f docker-compose.secure.yml up -d mariadb-experiment redis
docker compose -f docker-compose.secure.yml ps mariadb-experiment redis
```

For a native MariaDB installation instead, execute
`database/init-replay-mariadb.sql` as the local root account, then set the
host/port in [order-service/replay-config.js](./order-service/replay-config.js)
to the native server (normally `127.0.0.1:3306`). The runner uses the `mysql2/promise` driver and this JS
configuration for both preflight and Order Service connections; database
credentials are not read from environment variables. The defaults use the
requested local `root` account with an empty password, and preflight verifies
that it accepts TCP and has the required privileges. If the local root account
is socket-only, change the configured user to `mse_runner`; the SQL script
creates that account with only CREATE, INSERT, and SELECT privileges.

Run the quick experiment (1 repetition, 10 legitimate requests, 10 replay
attempts, concurrency levels 1 and 5):

```bash
node run-local-demo-2.js --mode quick
```

Run the larger default experiment (3 repetitions, 100 requests/attempts, and
concurrency 1, 10, and 50):

```bash
node run-local-demo-2.js --mode full
```

Experiment counts can be configured with CLI flags or their existing
`EXPERIMENT_*` variables. Redis can be overridden with `--redis-url`;
MariaDB/Redis defaults live in `order-service/replay-config.js`.

```bash
node run-local-demo-2.js --mode quick --repetitions 2 --requests 20 \
  --replays 25 --concurrency 1,10,50 --output ./my-results
REDIS_URL=redis://127.0.0.1:6379 node run-local-demo-2.js --mode full
```

Supported experiment environment variables include `EXPERIMENT_REPETITIONS`,
`EXPERIMENT_REQUESTS`, `EXPERIMENT_REPLAYS`, `EXPERIMENT_CONCURRENCY`,
`EXPERIMENT_OUTPUT_DIR`, `EXPERIMENT_TOKEN_TTL_SECONDS`, and `CERTS_DIR`.
Before any scenario starts, preflight checks Redis `PING`, atomic `SET NX`
with and without TTL, and MariaDB TCP connection, version, database,
privileges, InnoDB engine, primary key, and transactional INSERT/SELECT.
Failures include a sanitized reason in `metadata.json`, stop the run, create
no scenario results, and return a non-zero exit code. Partial scenarios never
count as completed.

Every invocation creates a unique output folder and writes observations as it
runs:

```text
results/replay-<UTC timestamp>-<id>/
├── metadata.json
├── scenarios.csv
├── requests.csv
├── summary.csv
└── events.jsonl
```

`requests.csv` is the source of truth: one row per measured first use, replay,
concurrent replay, and performance request. It includes request ID, one-way
`jti_hash`, method/store, requested and actual replica, request type/timestamps,
HTTP/store outcomes, and protected-operation execution evidence. Unknown
execution state remains empty, not `false`; JWTs and credentials are never
written. `scenarios.csv` records completed/partial/failed status and counts.
`summary.csv` groups security and performance metrics by scenario and
repetition. Percentiles use linear interpolation; standard deviation uses the
sample formula. Throughput is completed performance requests divided by the
request-observation time span, excluding token provisioning and warm-up.
CPU/process-memory usage is not sampled and those summary fields remain empty.

### Analyze with pandas/Jupyter

Install the analysis dependencies and run the notebook-ready analysis script:

```bash
python3 -m pip install pandas matplotlib
python3 analysis/analyze_replay_protection.py results/<experiment-directory>
```

The script validates that all 12 method/replica configurations and their
repetitions completed, verifies routing/concurrency/restart/protected-operation
observations, recomputes metrics from `requests.csv`, and compares them with
`summary.csv`. It writes a validation report and derived tables. Comparison
plots are emitted only when the full matrix is available and valid; otherwise
the analysis exits non-zero and marks the run invalid. To use it interactively
in Jupyter:

```bash
python3 -m pip install jupyter pandas matplotlib
jupyter lab
```

In JupyterLab, open `analysis/replay_protection_analysis_validated.ipynb` and
set the explicit experiment path in its setup cell. The three notebooks use
the same validator and do not display comparison plots for invalid/incomplete
runs. Alternatively, run the script from a terminal:

```python
%run analysis/analyze_replay_protection.py results/<experiment-directory>

import pandas as pd
requests = pd.read_csv("results/<experiment-directory>/requests.csv")
summary = pd.read_csv("results/<experiment-directory>/summary.csv")
```

### Metrics and reproducibility notes

- Replay detection rate = detected serial replays plus detected concurrent
  duplicates / (serial replay attempts + concurrent batch size minus one per
  `jti`). A concurrent batch's first use is excluded from that denominator.
- False acceptance rate = accepted serial replays plus concurrent acceptances
  beyond the first per `jti` / the same replay-attempt denominator.
- Legitimate acceptance rate = accepted legitimate first-use/performance
  requests / observed legitimate first-use/performance requests.
- False rejection rate = non-accepted legitimate first-use/performance
  requests / observed legitimate first-use/performance requests. Store and
  service errors remain separately reported.
- Cross-replica detection = detected replay requests routed to a different
  observed replica / observed cross-replica replay requests. It is not
  applicable to one-replica scenarios.
- Latency is runner-observed end-to-end HTTP latency; store latency is separately
  measured inside Order Service around `consume()`.
- Throughput = completed performance requests / wall-clock span of observed
  performance request timestamps; setup and warm-up are excluded.
- Protected-operation execution count includes only requests for which the
  Order Service handler returned explicit execution evidence.
- All methods use the same local machine, JWT rules, route, payload, and
  configured request counts. The local controlled testbed is not a production
  benchmark. Results depend on host load, Redis configuration, network stack,
  and process scheduling. The in-memory method intentionally loses its state
  on restart; Redis without TTL intentionally leaves the unique experiment
  keys in Redis after a run.

Run the replay-store and logging tests with:

```bash
npm test --prefix order-service
```
