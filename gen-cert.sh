#!/bin/bash

cd certs/

echo "1. Generating the CA private key ..."
openssl genpkey -algorithm RSA -out ca-key.pem

echo "2. Generating the self-signed CA certificate ..."
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 -out ca-cert.pem

echo "3. Generating the server private key ..."
openssl genpkey -algorithm RSA -out key.pem

echo "4. Generating the CSR (Certificate Signing Request) for the server ..."
openssl req -new -key key.pem -out server.csr

echo "5. Creating v3 extensions configuration file ..."
cat << EOF > v3.ext
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = yourdomain.com
DNS.2 = www.yourdomain.com
EOF

echo "6. Generating the signed SSL certificate with v3 extensions ..."
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial -out cert.pem -days 365 -sha256 -extfile v3.ext

echo "Certificate generation completed."
