UUID   := spotify-dock-controller@lsarazin
DOMAIN := spotify-dock-controller
ZIP    := $(UUID).shell-extension.zip
JS     := extension.js prefs.js player.js indicator.js dockPlacer.js artCache.js
SRC    := $(JS) stylesheet.css metadata.json
POT    := po/$(DOMAIN).pot
PO     := $(wildcard po/*.po)

# GNU gettext (msgfmt, xgettext, msgmerge) : celui de l'hôte s'il existe, sinon
# repli sur un runtime Flatpak (tools/flatpak-gettext.sh).
# `gnome-extensions pack --podir` appelle lui-même `msgfmt` via le PATH.
ifeq ($(shell command -v msgfmt 2>/dev/null),)
export PATH := $(CURDIR)/tools/gettext-bin:$(PATH)
endif

.PHONY: pack install check pot update-po clean

pack: $(ZIP)

$(ZIP): $(SRC) schemas/*.gschema.xml icons/* $(PO)
	gnome-extensions pack --force \
		--extra-source=player.js --extra-source=indicator.js \
		--extra-source=dockPlacer.js --extra-source=artCache.js \
		--extra-source=icons --podir=po \
		--schema=schemas/org.gnome.shell.extensions.spotify-dock-controller.gschema.xml .

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

check:
	glib-compile-schemas --strict --dry-run schemas/
	for f in *.js; do node --check --input-type=module < $$f || exit 1; done
	for po in $(PO); do msgfmt --check --statistics -o /dev/null $$po || exit 1; done

# Régénère le modèle de traduction à partir des sources
pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=N_ --keyword=ngettext:1,2 \
		--add-comments=TRANSLATORS: \
		--package-name='Spotify Dock Controller' \
		--msgid-bugs-address='https://github.com/lucassrz/spotify-dock-controller/issues' \
		-o $(POT) $(JS)

# Fusionne le modèle dans chaque traduction existante
update-po: pot
	for po in $(PO); do msgmerge --update --backup=none $$po $(POT) || exit 1; done

clean:
	rm -rf $(ZIP) schemas/gschemas.compiled locale
