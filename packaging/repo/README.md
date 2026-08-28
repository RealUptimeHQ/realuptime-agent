# apt and yum repository layout (REA-181)

Packaging scripts only. Nothing here publishes; the lead runs these steps by
hand and the host (`pkg.realuptime.io`) does not exist until the owner says
so. Written down so the layout is decided once, before the first package,
rather than improvised at publish time.

## Artifacts

`build-release.sh` -> `build-deb.sh` / `build-rpm.sh` leave in
`apps/agent/packaging/out/`:

- `realuptime-agent-<ver>.tgz`, `.zip`, `SHA256SUMS`, `SHA256SUMS.sig`
  (attached to the GitHub release `agent-<ver>`; what `install.sh` and
  `install-windows.ps1` download)
- `realuptime-agent_<ver>_all.deb`
- `realuptime-agent-<ver>-1.noarch.rpm`

Both packages are architecture-independent (they ship compiled JavaScript
and depend on the distribution's `nodejs >= 22`).

## apt (`https://pkg.realuptime.io/apt`)

One suite, `stable`, one component, `main`, managed with `reprepro`:

```
apt/
  conf/distributions        # Codename: stable / Components: main / Architectures: all / SignWith: <key id>
  dists/stable/...          # generated
  pool/main/r/realuptime-agent/realuptime-agent_<ver>_all.deb
  realuptime-archive-keyring.gpg   # the public signing key, served at /apt/realuptime-archive-keyring.gpg
```

Publish: `reprepro -b apt includedeb stable out/realuptime-agent_<ver>_all.deb`.

Customer side (the KB how-to says exactly this):

```
curl -fsSL https://pkg.realuptime.io/apt/realuptime-archive-keyring.gpg | sudo tee /usr/share/keyrings/realuptime-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/realuptime-archive-keyring.gpg] https://pkg.realuptime.io/apt stable main" | sudo tee /etc/apt/sources.list.d/realuptime.list
sudo apt update && sudo apt install realuptime-agent
echo 'REALUPTIME_TOKEN=rua_...' | sudo tee /etc/realuptime-agent/env >/dev/null
sudo systemctl enable --now realuptime-agent
```

## yum / dnf (`https://pkg.realuptime.io/rpm`)

One repository, `noarch`, metadata from `createrepo_c`, packages signed with
`rpm --addsign` using the same key:

```
rpm/
  noarch/realuptime-agent-<ver>-1.noarch.rpm
  noarch/repodata/          # createrepo_c rpm/noarch
  RPM-GPG-KEY-realuptime    # public key
  realuptime.repo           # the file below
```

`realuptime.repo`:

```
[realuptime]
name=RealUptime
baseurl=https://pkg.realuptime.io/rpm/noarch
enabled=1
gpgcheck=1
gpgkey=https://pkg.realuptime.io/rpm/RPM-GPG-KEY-realuptime
```

Customer side:

```
sudo curl -fsSL -o /etc/yum.repos.d/realuptime.repo https://pkg.realuptime.io/rpm/realuptime.repo
sudo dnf install realuptime-agent
echo 'REALUPTIME_TOKEN=rua_...' | sudo tee /etc/realuptime-agent/env >/dev/null
sudo systemctl enable --now realuptime-agent
```

## Signing

One GPG key for both repositories, generated offline, public half served at
the two URLs above and its fingerprint printed on docs.realuptime.io/monitor-agent.
The release tarball/zip checksums are signed with the existing cosign key
(`.well-known/cosign.pub`), the same key the Docker image is signed with, so a
customer already verifying the image has nothing new to trust. Private keys
live in the vault (standing order), never in this repository.
