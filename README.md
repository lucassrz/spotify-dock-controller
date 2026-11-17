# Spotify Dock Controller

Extension GNOME Shell (48–50, testée sur 50.1 / Wayland) pour piloter Spotify via MPRIS :
titre — artiste dans un indicateur, popup avec pochette, progression cliquable,
précédent / lecture-pause / suivant, aléatoire et répétition.
Placement au choix : barre du haut, ou **en bas à gauche/droite du dock** (Ubuntu Dock / Dash to Dock).

## Installation

```sh
make install          # gnome-extensions pack + install --force
```

ou à la main : copier les fichiers dans
`~/.local/share/gnome-shell/extensions/spotify-dock-controller@lsarazin/` puis
`glib-compile-schemas schemas/` dans ce dossier.

## Activation

Sous Wayland, une **nouvelle** extension n'est vue par GNOME Shell qu'après une
déconnexion/reconnexion. Ensuite :

```sh
gnome-extensions enable spotify-dock-controller@lsarazin
```

Logs : `journalctl --user -f -o cat /usr/bin/gnome-shell`
(option « Journaux de placement » dans les préférences pour voir la géométrie du dock).

## Réglages

`gnome-extensions prefs spotify-dock-controller@lsarazin` — tout s'applique à chaud :

- Emplacement : barre du haut (gauche / centre / droite + index) ou à gauche / à droite du dock (+ décalage en px)
- Masquer en vue d'ensemble (mode dock)
- Afficher le texte, longueur max, mini-pochette, masquer (ou griser) quand Spotify est fermé
- Clic milieu = lecture/pause

## Fonctionnement

- Présence de Spotify suivie par `Gio.bus_watch_name` (NameOwnerChanged) sur `org.mpris.MediaPlayer2.spotify`.
- Spotify ne notifie pas `Position` : elle est relue (Properties.Get) toutes les secondes **uniquement quand le popup est ouvert** (+ signal `Seeked`). Shuffle/LoopStatus sont relus à l'ouverture.
- Seek : `SetPosition(trackid, position)`.
- Pochettes : téléchargées en asynchrone (Soup 3) dans `~/.cache/spotify-dock-controller@lsarazin/<sha256(url)>`, 200 fichiers max.
- Mode dock : widget flottant ajouté par `Main.layoutManager.addChrome()` (pas de strut, masqué en plein écran),
  aligné sur l'acteur `dash-background` du conteneur `dashtodockContainer` (enfant de `Main.layoutManager.uiGroup`),
  recalé sur `notify::allocation`, `monitors-changed`, `workareas-changed` et quand le dock est recréé.
  Le popup s'ouvre vers le haut (`PopupMenu` avec `St.Side.BOTTOM`).

## Tests

`make check` : schéma (`--strict`) + syntaxe JS.

`tests/run-headless.sh` : lance un `gnome-shell --headless` totalement isolé (bus privé, XDG/HOME temporaires,
GSettings en keyfile — rien n'est écrit dans la session réelle), avec Ubuntu Dock, un faux Spotify MPRIS et une
pochette servie en local ; vérifie placement, popup, seek, boutons, vrais clics (pointeur virtuel), prefs,
disable/enable, puis enregistre des captures.

## Limites

- Détection du dock basée sur les noms internes d'Ubuntu Dock / Dash to Dock (`dashtodockContainer`,
  `dash-background`) : si une version future les renomme, repli au centre-bas de l'écran + décalage.
- Dock horizontal supposé (BOTTOM) : avec un dock vertical, le widget utilise le repli centre-bas.
- Moniteur principal uniquement.
- Avec blur-my-shell, la couleur du dock peut être transparente : le widget garde alors son propre fond.
- Testé uniquement sur GNOME Shell 50 (48/49 déclarés : chemin de code sans `Clutter.ClickGesture` non testé).
