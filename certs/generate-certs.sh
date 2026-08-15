#!/bin/bash
# generate-certs.sh
# Generates CA, server, and client certificates for mTLS

set -e

CERTS_DIR="./certs"
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

echo "=== Generating mTLS Certificates ==="
echo ""

# 1. Generate Certificate Authority (CA)
echo "[1/6] Generating CA private key..."
openssl genrsa -out ca.key 2048

echo "[2/6] Generating CA certificate..."
openssl req -x509 -new -nodes \
  -key ca.key \
  -out ca.pem \
  -days 365 \
  -subj "/CN=MicroservicesCA/O=ResearchLab/C=US"

# 2. Generate Order Service server certificate
echo "[3/6] Generating Order Service private key..."
openssl genrsa -out order.key 2048

echo "[4/6] Generating Order Service CSR..."
openssl req -new \
  -key order.key \
  -out order.csr \
  -subj "/CN=order-service/O=ResearchLab/C=US"

echo "[5/6] Signing Order Service certificate with CA..."
openssl x509 -req \
  -in order.csr \
  -CA ca.pem \
  -CAkey ca.key \
  -CAcreateserial \
  -out order.pem \
  -days 365

# 3. Generate client certificate (for services calling order-service)
echo "[6/6] Generating client certificate..."
openssl genrsa -out client.key 2048
openssl req -new \
  -key client.key \
  -out client.csr \
  -subj "/CN=gateway-client/O=ResearchLab/C=US"
openssl x509 -req \
  -in client.csr \
  -CA ca.pem \
  -CAkey ca.key \
  -CAcreateserial \
  -out client.pem \
  -days 365

echo ""
echo "=== Certificate Generation Complete ==="
echo "Files created:"
ls -la *.pem *.key 2>/dev/null || true
echo ""
echo "CA Certificate:           ca.pem"
echo "Order Service Cert:       order.pem"
echo "Order Service Key:        order.key"
echo "Client Certificate:       client.pem"
echo "Client Key:               client.key"
