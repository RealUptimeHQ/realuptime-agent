# Security

The agent is designed to be boring to audit: outbound HTTPS only, no inbound
ports, no configuration file, no plugins, no shell-outs to collect metrics
that a library call can provide, and zero runtime dependencies.

## Reporting a vulnerability

Email security@realuptime.io with the subject "RealUptime security report".
Please do not open a public issue for anything you believe is exploitable.

- The policy (scope, what we commit to in response, coordinated disclosure,
  and the protection given to good-faith researchers) is at
  https://realuptime.io/security/disclosure.
- The same contact in machine-readable form (RFC 9116):
  https://realuptime.io/.well-known/security.txt.

Include what is affected, how to reproduce it and the impact you believe it
has. Do not include secrets you do not need to share.

## Supported versions

The latest release receives security fixes. A fix ships as a new release of
this repository.

## Verifying the official image

Official images are signed with cosign; the verification command and public
key are documented at https://realuptime.io/security.
