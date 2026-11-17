// Spotify Dock Controller — point d'entrée.
//
// enable()  : crée le client MPRIS, le cache de pochettes et l'indicateur au
//             placement choisi (barre du haut ou à côté du dock).
// disable() : détruit tout (signaux, timeouts, proxy D-Bus, session Soup).
// Un changement de placement dans les préférences reconstruit l'indicateur à chaud.

import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SpotifyPlayer} from './player.js';
import {ArtCache} from './artCache.js';
import {SpotifyIndicator} from './indicator.js';
import {DockPlacer} from './dockPlacer.js';

const STATUS_ROLE = 'spotify-dock-controller';

export default class SpotifyDockControllerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._player = new SpotifyPlayer();
        this._artCache = new ArtCache(this.uuid);

        this._settings.connectObject(
            'changed::placement', () => this._rebuild(),
            'changed::panel-index', () => {
                if (this._settings.get_string('placement').startsWith('panel-'))
                    this._rebuild();
            }, this);

        this._build();
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._teardown();
        this._artCache?.destroy();
        this._artCache = null;
        this._player?.destroy();
        this._player = null;
        this._settings = null;
    }

    _build() {
        const placement = this._settings.get_string('placement');
        const inDock = placement.startsWith('dock-');

        this._indicator = new SpotifyIndicator({
            player: this._player,
            artCache: this._artCache,
            settings: this._settings,
            extensionPath: this.path,
            arrowSide: inDock ? St.Side.BOTTOM : St.Side.TOP,
            floating: inDock,
        });

        if (inDock) {
            this._indicator.menu.actor.add_style_class_name('sdc-menu-up');
            // Hors barre du haut : il faut notre propre gestionnaire de menu
            // (grab modal, fermeture au clic extérieur / Échap).
            this._menuManager = new PopupMenu.PopupMenuManager(this._indicator);
            this._menuManager.addMenu(this._indicator.menu);
            this._placer = new DockPlacer(this._indicator, this._settings,
                placement === 'dock-left' ? 'left' : 'right');
        } else {
            const box = placement.slice('panel-'.length); // left | center | right
            const index = this._settings.get_int('panel-index');
            Main.panel.addToStatusArea(STATUS_ROLE, this._indicator, index, box);
        }
    }

    _teardown() {
        if (this._menuManager && this._indicator)
            this._menuManager.removeMenu(this._indicator.menu);
        this._menuManager = null;
        this._placer?.destroy();
        this._placer = null;
        // Pour le mode barre : destroy() retire aussi l'entrée de
        // Main.panel.statusArea (Panel écoute 'destroy' de l'indicateur).
        this._indicator?.destroy();
        this._indicator = null;
    }

    _rebuild() {
        this._teardown();
        this._build();
    }
}
