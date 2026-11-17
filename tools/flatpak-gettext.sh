#!/bin/sh
# Repli quand GNU gettext n'est pas installé sur l'hôte (paquet `gettext`) :
# exécute l'outil demandé (nom du lien symbolique : msgfmt, xgettext, msgmerge,
# msginit) depuis un runtime Flatpak qui le fournit (org.freedesktop/org.gnome
# Platform ou Sdk). Le Makefile ne s'en sert que si `msgfmt` est introuvable.
# Forcer un runtime : GETTEXT_FLATPAK_RUNTIME=org.freedesktop.Platform//25.08
tool=$(basename "$0")
runtime=${GETTEXT_FLATPAK_RUNTIME:-$(flatpak list --runtime --columns=ref 2>/dev/null |
    grep -E '^org\.(freedesktop|gnome)\.(Platform|Sdk)/[^/]+/[0-9.]+$' | sort -t/ -k3 -V | tail -n 1)}
if [ -z "$runtime" ]; then
    echo "$tool: GNU gettext not found. Install it (e.g. 'sudo apt install gettext')." >&2
    exit 127
fi
exec flatpak run --filesystem=host --filesystem=/tmp --command="$tool" "$runtime" "$@"
