UUID := spotify-dock-controller@lsarazin
ZIP  := $(UUID).shell-extension.zip
SRC  := extension.js prefs.js player.js indicator.js dockPlacer.js artCache.js stylesheet.css metadata.json

.PHONY: pack install check clean

pack: $(ZIP)

$(ZIP): $(SRC) schemas/*.gschema.xml icons/*
	gnome-extensions pack --force \
		--extra-source=player.js --extra-source=indicator.js \
		--extra-source=dockPlacer.js --extra-source=artCache.js \
		--extra-source=icons --schema=schemas/org.gnome.shell.extensions.spotify-dock-controller.gschema.xml .

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

check:
	glib-compile-schemas --strict --dry-run schemas/
	for f in *.js; do node --check --input-type=module < $$f || exit 1; done

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
