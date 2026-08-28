/**
 * A throwaway self-signed certificate for `localhost`, used by
 * `check-tcp.test.ts` to stand up an ephemeral local TLS listener and prove
 * the agent completes a handshake against a certificate no public CA would
 * ever sign. That is the NORMAL case inside a customer's network, and the case
 * certificate validation would report as a false outage.
 *
 * ## Why it is inline rather than a .pem file
 *
 * The repository's `.gitignore` refuses `*.pem` and `*.key` outright, which is
 * a deliberate net against key material reaching git (security audit run 1).
 * Adding an exception to that rule so a TEST could keep a key next to it would
 * weaken a real control for a fixture's convenience. The rule stays as it is
 * and the fixture lives here instead.
 *
 * ## What this key protects
 *
 * Nothing. It was generated for this test, has never been used anywhere, is
 * bound to `CN=localhost`, and is served only by a listener this test starts
 * on 127.0.0.1 and closes when it finishes. If a secret scanner flags it, this
 * paragraph is the answer.
 */

export const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC1jXGpvmaXPAUi
J9ilS1hPp1hTsGsIufbZvDZVIhBaAyIihkErw++mdN12lI0qrnwmFtI01kuALBcz
Z+IGtyxfPHfXww1GNz1MB8JdgL2wiH1RZ7UuedHJdMUOPFeyfX5gP9lGYCG/Rcr5
dMX2GEUAFzFWxid8Q3tcEHtpugTlLQUtnV70jd0dhjeoElCwiwU5C2rgJOf7+OcI
33Sk5FXFhQxkiSoYxamcfVGUHrjBKlV9KIcSJ9bhpUN2+Ca202UEMHj4onu9Okjz
aMxYpcG41EoSuVTz5WcncVNRS/rTYwKRI1d7X8rf8iihP0M/iLcGrw3QLidGJ9Gq
3bVKToM3AgMBAAECggEAJV53SlKUCEYE4npkJ+XByCdwUU2LQnEQo9GPN2e7COQD
Nyr+KBV88vy0Bu/dvK7MhASHgPOo97lbjyuvROWYHwQxwLn3tf+xwMAKHDffE4KM
lOBtVSMi8L31v4/hFy6ogAQ0Yz1vRNEHTeBgzN5C+ZlMgQlpYDT9o74KwQDWeBs6
6FA7KdPJUEJ7o9cYFXlK/7YVdDiraRcH8WD56OSB/eOSxqT8JHuZN1b8r2ToY928
l+jIn9QfzGCACYckqubGCnYsPfF2eZNdIKxx2VAv6Rhri7oVPKMxLCJCMXmC1wMf
u4kJU+um+PJoeL33EZqphXsJjfKP7AVImlJ6Cgt9RQKBgQDZfnQnrIxKv6CTjDbu
Ved1Ek23kN8Em4FYCCWkzvh0tz1P4iTFHpisgSlSIBrCmjvil5CyGCaZ3RIRpbBD
PVLJZ7unwBkaPQXhvr0pU6PlwvE2nUI4g4yKBuAOR6O4dajYUTOD7iaT1LVdc8aP
Ao02QKu1jSt2cr4C02QmPgUhDQKBgQDVsgFJiWeCBq3lWRzUj4qqMru+GilX228t
56+uiD9E+bd0gPRTVouUUoo56pO4zSeobiPgngZLIyR2EgKp4shMG+gaYyNDZsI1
2A7Lg1w6FaseFWXI/VftkLLaonsiPIRSEky+cJO2WqR9TyYPReXH16Rq44C+RR1M
BEoKi4z8UwKBgEd5P/C9yojR+pIidPbT8jFN545YpIGeHN5yJvTHM20fvp1e4tiI
moGuHIcpl8G179IiHuH3/892j/aOraMbJvabCVcyUM2HmkQ6a22GWAksjBp3iYiK
6od9hOoMbugyel9EKBrGC5VvRH7Gikz6+K8Ih6UtFEhjor/I+lN69DKNAoGAV0JV
hjqmWpDxp0pJHH70p2UKBqlWInsHHh6SPVmDRF4XzGnv2qvnWQyPRvEDmx2iyQMY
gVrlxP63n8Lg9ZAWLAXlNAkxWA941FXCTNX57fn1Itan9neE1QwWDHL2htdhTMYO
MmFz362Jp2WPbAMlvgHPMJpvcsJ0IRtLRJ0RV+MCgYBsZcZDGz6KiDoDgQDgWVLS
Twq7VFZRTe5KT+6EraAuSkhwTfzcfaHpjSeVqj2138aTBYv+4EXwk0ZYV21B/1um
n3botkAA2hZtTzhJSNN80Wr3jqHBzqteLNdm1A3r27n8PhjZTLo5Y15dP+FCK//3
BjLunHynq5y/zrt0M1bCPA==
-----END PRIVATE KEY-----
`;

export const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUembBb6jF4Iqg6ou9BEySAVNcLlUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgxNzE3MjAzOFoYDzIxMjYw
NzI0MTcyMDM4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC1jXGpvmaXPAUiJ9ilS1hPp1hTsGsIufbZvDZVIhBa
AyIihkErw++mdN12lI0qrnwmFtI01kuALBczZ+IGtyxfPHfXww1GNz1MB8JdgL2w
iH1RZ7UuedHJdMUOPFeyfX5gP9lGYCG/Rcr5dMX2GEUAFzFWxid8Q3tcEHtpugTl
LQUtnV70jd0dhjeoElCwiwU5C2rgJOf7+OcI33Sk5FXFhQxkiSoYxamcfVGUHrjB
KlV9KIcSJ9bhpUN2+Ca202UEMHj4onu9OkjzaMxYpcG41EoSuVTz5WcncVNRS/rT
YwKRI1d7X8rf8iihP0M/iLcGrw3QLidGJ9Gq3bVKToM3AgMBAAGjUzBRMB0GA1Ud
DgQWBBTzyiTEyobX7qRmRP972wZnObESRzAfBgNVHSMEGDAWgBTzyiTEyobX7qRm
RP972wZnObESRzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCR
vHefvCfl8XrSbsy/sd+TmathqQ77PTMgZ+tVJz3BTFQ4V4eunaqlNfESEbIQ+X43
wFsj7B9nd+VmJnPXfQmBp42IFSvYmkPkCRS3aFbBfkqk/53QcbKgW96Im1RDAysF
d6A3NyqnvaLlVkVorEGlRiUdTX0SYboNKRNq0+yH7fN6ST6iru2dk39Wzy83wzZI
fV3Jo7rqQvzOXlGKFRYlMXrIsUSAVQtWDjlT7ZNexLRcekD+IyEemHl4n9vkK1fH
Oq0uNV3LISlBUKQh1JSGbXUZXRi0o7H3GU/bxMaWUSJZsPzVhuXatGfoeE4J5dzp
aRt1TV+sBZpO7KwZBiXX
-----END CERTIFICATE-----
`;
