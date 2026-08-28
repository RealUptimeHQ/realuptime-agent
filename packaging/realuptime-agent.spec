Name:           realuptime-agent
Version:        @VERSION@
Release:        1%{?dist}
Summary:        RealUptime Monitor agent
License:        Proprietary
URL:            https://docs.realuptime.io/monitor-agent
Source0:        realuptime-agent-%{version}.tar.gz
BuildArch:      noarch
Requires:       nodejs >= 22
Requires(pre):  shadow-utils
%{?systemd_requires}
BuildRequires:  systemd-rpm-macros

%description
Outbound-only monitoring agent: runs checks against private targets from
inside your network and reports server health (CPU, memory, disk, load,
network, processes, containers, watched services). No inbound port, no
config file beyond the token, zero runtime dependencies.

%prep
%setup -q

%install
mkdir -p %{buildroot}/opt/realuptime-agent %{buildroot}%{_unitdir} %{buildroot}%{_sysconfdir}/realuptime-agent
cp -R dist %{buildroot}/opt/realuptime-agent/dist
cp package.json %{buildroot}/opt/realuptime-agent/
install -m 0644 realuptime-agent.service %{buildroot}%{_unitdir}/realuptime-agent.service
touch %{buildroot}%{_sysconfdir}/realuptime-agent/env

%pre
getent group realuptime-agent >/dev/null || groupadd -r realuptime-agent
getent passwd realuptime-agent >/dev/null || useradd -r -g realuptime-agent -s /sbin/nologin -d / realuptime-agent
exit 0

%post
%systemd_post realuptime-agent.service
if [ ! -s %{_sysconfdir}/realuptime-agent/env ]; then
  echo "realuptime-agent: write REALUPTIME_TOKEN=rua_... to %{_sysconfdir}/realuptime-agent/env (mode 0600), then: systemctl enable --now realuptime-agent"
fi

%preun
%systemd_preun realuptime-agent.service

%postun
%systemd_postun_with_restart realuptime-agent.service

%files
/opt/realuptime-agent
%{_unitdir}/realuptime-agent.service
%dir %attr(0750, root, realuptime-agent) %{_sysconfdir}/realuptime-agent
%config(noreplace) %attr(0600, root, root) %{_sysconfdir}/realuptime-agent/env
