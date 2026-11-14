# gVisor (runsc) on a worker host — UNVERIFIED

Dedicated Linux worker (e.g. AWS EC2, 4 vCPU / 16 GiB, Ubuntu 24.04). Block the metadata endpoint (169.254.169.254) at the host firewall.

1. Install gVisor: https://gvisor.dev/docs/user_guide/install/
2. `sudo runsc install && sudo systemctl restart docker` (registers the `runsc` runtime).
3. Smoke test: `docker run --rm --runtime=runsc --network=none hello-world`.
4. Spike F2 (plan §10.1): run the harness 20x, confirm libfaketime, `setarch -R`, start latency.
