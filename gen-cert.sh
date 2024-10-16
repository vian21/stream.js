!#/bin/bash

cd certs/

echo "1. Generating the private key ..."
openssl genrsa -out key.pem

echo "2. Generating the CSR (Certificate Signing Request) ..."
openssl req -new -key key.pem -out csr.pem

echo "3. Generating the SSL Certificate ..."
openssl x509 -req -days 365 -in csr.pem -signkey key.pem -out cert.pem
