# TLS Test Fixture

The self-signed certificate and unencrypted key in this directory are public,
test-only fixtures. Never use them for deployment credentials. The certificate
identifies localhost and 127.0.0.1 so probes can test TLS identity verification
without contacting an external service.
