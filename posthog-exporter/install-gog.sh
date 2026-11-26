#!/bin/sh
set -eu
# Called once per pod, in a private temporary directory. Only the Gmail collector
# depends on this download. The hashes are from the upstream v0.48.1 release.
case "$(uname -m)" in
  aarch64|arm64)
    arch=arm64
    sha=c091fa2014dc3d5608acef4d09fb3bb4a3eb71e4cff898b5eaddd9703599e45c ;;
  x86_64|amd64)
    arch=amd64
    sha=dcd956e09d1222a07c1304d836f8acd55266b2fa241ef466580ced6a02453d72 ;;
  *) exit 1 ;;
esac
wget -q -T 30 -O release.tar.gz "https://github.com/openclaw/gogcli/releases/download/v0.48.1/gogcli_0.48.1_linux_${arch}.tar.gz"
printf '%s  release.tar.gz\n' "$sha" | sha256sum -c - >/dev/null
tar xzf release.tar.gz ./gog
chmod 0700 gog
rm release.tar.gz
