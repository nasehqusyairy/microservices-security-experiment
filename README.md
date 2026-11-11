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
