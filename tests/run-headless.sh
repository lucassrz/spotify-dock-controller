#!/bin/bash
# Test de bout en bout dans un gnome-shell --headless TOTALEMENT isolé :
# bus de session privé (dbus-run-session), HOME/XDG_* temporaires, GSettings en
# keyfile (aucune écriture dans le dconf réel), faux Spotify MPRIS, pochette
# servie en local. N'affecte pas la session en cours.
#   ./tests/run-headless.sh            -> résultats [PASS]/[FAIL] + captures
set -u
N="$(cd "$(dirname "$0")" && pwd)"
SRC="$(dirname "$N")"
UUID=spotify-dock-controller@lsarazin
T="$(mktemp -d /tmp/sdc-test.XXXX)"   # chemin court : socket Wayland < 108 octets
mkdir -p "$T"/{home,config/glib-2.0/settings,data/gnome-shell/extensions,cache,run,out,www}
chmod 700 "$T/run"
mkdir "$T/data/gnome-shell/extensions/$UUID"
cp -r "$SRC"/{metadata.json,*.js,stylesheet.css,icons,schemas} "$T/data/gnome-shell/extensions/$UUID/"
glib-compile-schemas "$T/data/gnome-shell/extensions/$UUID/schemas"
cp /usr/share/spotify/icons/spotify-linux-256.png "$T/www/cover.img" 2>/dev/null ||
    cp "$SRC/icons/spotify-symbolic.svg" "$T/www/cover.img"
cat > "$T/config/glib-2.0/settings/keyfile" <<KF
[org/gnome/shell]
enabled-extensions=['ubuntu-dock@ubuntu.com', '$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/shell/extensions/dash-to-dock]
dock-position='BOTTOM'
dock-fixed=true
extend-height=false
KF
export HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/run"
export SDC_OUT="$T/out" SDC_FAKE="$N/fake-spotify.js" SDC_ART="http://127.0.0.1:8765/cover.img"
export GSETTINGS_BACKEND=keyfile NO_AT_BRIDGE=1
unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS
timeout 150 dbus-run-session -- bash -c "
  trap 'kill \$(jobs -p) 2>/dev/null' EXIT
  python3 -m http.server 8765 --bind 127.0.0.1 --directory '$T/www' >/dev/null 2>&1 &
  gjs -m '$SDC_FAKE' '$SDC_ART' &
  sleep 1
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x900 --automation-script='$N/autotest.js'
" > "$T/shell.log" 2>&1
grep -E '^\[(PASS|FAIL|TEST)\]|JS ERROR' "$T/shell.log"
echo "Journal complet : $T/shell.log — captures : $T/out/"
