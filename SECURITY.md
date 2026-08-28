# Security

The agent is designed to be boring to audit: outbound HTTPS only, no inbound
ports, no configuration file, no plugins, no shell-outs to collect metrics
that a library call can provide, and zero runtime dependencies.

## Reporting a vulnerability

Email security@realuptime.io. We respond within 72 hours. Please do not open
a public issue for anything you believe is exploitable.

## Verifying the official image

Official images are signed with cosign; the verification command and public
key are documented at https://realuptime.io/security.
