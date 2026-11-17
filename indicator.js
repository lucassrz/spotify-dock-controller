// Indicateur (PanelMenu.Button) + contenu du popup.
//
// Le même widget sert pour la barre du haut et pour le mode « à côté du dock » ;
// seul le côté de la flèche du popup change (St.Side.TOP / St.Side.BOTTOM).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const POLL_INTERVAL_S = 1;
const COVER_SIZE = 192;
const MINI_ART_SIZE = 18;

function formatTime(us) {
    if (!Number.isFinite(us) || us < 0)
        us = 0;
    const total = Math.floor(us / 1e6);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function truncate(text, max) {
    const chars = [...text];
    if (chars.length <= max)
        return text;
    return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

function controlButton(iconName, accessibleName, styleClass = 'sdc-control-button') {
    const icon = new St.Icon({icon_name: iconName, style_class: 'sdc-control-icon'});
    return new St.Button({
        style_class: styleClass,
        child: icon,
        can_focus: true,
        accessible_name: accessibleName,
        x_expand: false,
    });
}

export const SpotifyIndicator = GObject.registerClass({
    GTypeName: 'SpotifyDockControllerIndicator',
}, class SpotifyIndicator extends PanelMenu.Button {
    /**
     * @param {object} params
     * @param {import('./player.js').SpotifyPlayer} params.player
     * @param {import('./artCache.js').ArtCache} params.artCache
     * @param {Gio.Settings} params.settings
     * @param {string} params.extensionPath
     * @param {St.Side} params.arrowSide St.Side.TOP (barre) ou St.Side.BOTTOM (dock)
     * @param {boolean} params.floating widget hors barre du haut
     */
    _init({player, artCache, settings, extensionPath, arrowSide, floating}) {
        super._init(0.5, 'Spotify', true);

        this._player = player;
        this._artCache = artCache;
        this._settings = settings;
        this._floating = floating;
        this._pollId = 0;
        this._dragging = false;
        this._artToken = 0;
        this._currentArt = null;

        this.add_style_class_name('sdc-indicator');
        if (floating)
            this.add_style_class_name('sdc-floating');

        // --- Contenu de l'indicateur -------------------------------------
        this._appIcon = new Gio.FileIcon({
            file: Gio.File.new_for_path(`${extensionPath}/icons/spotify-symbolic.svg`),
        });
        this._box = new St.BoxLayout({style_class: 'sdc-indicator-box', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({
            gicon: this._appIcon,
            style_class: 'system-status-icon sdc-indicator-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._miniArt = new St.Icon({
            icon_size: MINI_ART_SIZE,
            style_class: 'sdc-mini-art',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._label = new St.Label({
            style_class: 'sdc-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._box.add_child(this._icon);
        this._box.add_child(this._miniArt);
        this._box.add_child(this._label);
        this.add_child(this._box);

        // --- Menu (côté de la flèche selon le placement) --------------------
        this.setMenu(new PopupMenu.PopupMenu(this, 0.5, arrowSide));
        this.menu.actor.add_style_class_name('sdc-menu');
        this._buildMenu();

        // --- Clics -----------------------------------------------------------
        // GNOME 50 : PanelMenu.Button ouvre le menu via un Clutter.ClickGesture
        // (this._clickGesture, n'importe quel bouton). On le remplace par le
        // nôtre pour distinguer le clic milieu. setMenu() n'est plus rappelé
        // ensuite, donc la référence _clickGesture reste cohérente.
        // GNOME 48/49 : pas de gesture, PanelMenu.Button.vfunc_event() ouvre le
        // menu ; un handler 'event' (exécuté avant le vfunc) intercepte le clic
        // milieu. (Pas d'override de vfunc_event : en 50 le parent ne
        // l'implémente plus et super.vfunc_event() lèverait une erreur.)
        this._usesGesture = false;
        if (Clutter.ClickGesture && this._clickGesture) {
            this.remove_action(this._clickGesture);
            const gesture = new Clutter.ClickGesture({recognize_on_press: true});
            gesture.connect('recognize', g => this._onClick(g.get_button()));
            this._clickGesture = gesture;
            this.add_action(gesture);
            this._usesGesture = true;
        } else {
            this.connect('event', (_actor, event) => {
                if (event.type() === Clutter.EventType.BUTTON_PRESS &&
                    event.get_button() === Clutter.BUTTON_MIDDLE &&
                    this._settings.get_boolean('middle-click-play-pause')) {
                    this._player.playPause();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        // --- Signaux --------------------------------------------------------
        this._player.connectObject(
            'changed', () => this._sync(),
            'running-changed', () => this._sync(),
            'position', () => this._updatePosition(), this);

        this._settings.connectObject(
            'changed::show-text', () => this._sync(),
            'changed::max-text-length', () => this._sync(),
            'changed::show-mini-art', () => this._sync(),
            'changed::hide-when-closed', () => this._sync(), this);

        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open) {
                // le popup passe au-dessus du reste du chrome (dock compris)
                const parent = this.menu.actor.get_parent();
                parent?.set_child_above_sibling(this.menu.actor, null);
                this._player.refreshPosition();
                this._player.refreshExtras();
            }
            this._updatePolling();
        }, this);

        this._sync();
    }

    _onClick(button) {
        if (button === Clutter.BUTTON_MIDDLE &&
            this._settings.get_boolean('middle-click-play-pause')) {
            this._player.playPause();
            return;
        }
        this.menu.toggle();
    }

    _buildMenu() {
        // reactive: false donnerait le style :insensitive (texte grisé) ;
        // on garde l'item réactif mais sans activation ni survol.
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'sdc-player-item',
        });
        const vbox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sdc-player',
            x_expand: true,
        });
        item.add_child(vbox);

        this._cover = new St.Icon({
            icon_size: COVER_SIZE,
            style_class: 'sdc-cover',
            x_align: Clutter.ActorAlign.CENTER,
            icon_name: 'audio-x-generic-symbolic',
        });
        vbox.add_child(this._cover);

        this._titleLabel = new St.Label({style_class: 'sdc-title', x_align: Clutter.ActorAlign.CENTER});
        this._artistLabel = new St.Label({style_class: 'sdc-artist', x_align: Clutter.ActorAlign.CENTER});
        this._albumLabel = new St.Label({style_class: 'sdc-album', x_align: Clutter.ActorAlign.CENTER});
        this._albumLabel.opacity = 170;
        for (const l of [this._titleLabel, this._artistLabel, this._albumLabel]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            vbox.add_child(l);
        }

        this._slider = new Slider.Slider(0);
        this._slider.add_style_class_name('sdc-progress');
        this._slider.accessible_name = _('Progress');
        this._slider.connectObject(
            'drag-begin', () => {
                this._dragging = true;
            },
            'drag-end', () => {
                this._dragging = false;
                this._seekToSlider();
            },
            'notify::value', () => {
                if (this._updatingSlider)
                    return;
                if (this._dragging) {
                    this._elapsedLabel.text = formatTime(this._slider.value * this._player.lengthUs);
                    return;
                }
                // changement utilisateur hors glisser (molette, flèches clavier)
                this._scheduleSeek();
            }, this);
        vbox.add_child(this._slider);

        const timeBox = new St.BoxLayout({style_class: 'sdc-time-box', x_expand: true});
        this._elapsedLabel = new St.Label({text: '0:00', style_class: 'sdc-time', x_expand: true});
        this._durationLabel = new St.Label({text: '0:00', style_class: 'sdc-time', x_align: Clutter.ActorAlign.END});
        this._elapsedLabel.opacity = this._durationLabel.opacity = 190;
        timeBox.add_child(this._elapsedLabel);
        timeBox.add_child(this._durationLabel);
        vbox.add_child(timeBox);

        const controls = new St.BoxLayout({style_class: 'sdc-controls', x_align: Clutter.ActorAlign.CENTER});
        this._shuffleBtn = controlButton('media-playlist-shuffle-symbolic', _('Shuffle'), 'sdc-control-button sdc-toggle');
        this._prevBtn = controlButton('media-skip-backward-symbolic', _('Previous'));
        this._playBtn = controlButton('media-playback-start-symbolic', _('Play/Pause'), 'sdc-control-button sdc-play');
        this._nextBtn = controlButton('media-skip-forward-symbolic', _('Next'));
        this._repeatBtn = controlButton('media-playlist-repeat-symbolic', _('Repeat'), 'sdc-control-button sdc-toggle');
        this._shuffleBtn.connect('clicked', () => this._player.toggleShuffle());
        this._prevBtn.connect('clicked', () => this._player.previous());
        this._playBtn.connect('clicked', () => this._player.playPause());
        this._nextBtn.connect('clicked', () => this._player.next());
        this._repeatBtn.connect('clicked', () => this._player.cycleLoop());
        for (const b of [this._shuffleBtn, this._prevBtn, this._playBtn, this._nextBtn, this._repeatBtn])
            controls.add_child(b);
        vbox.add_child(controls);

        this._notRunningLabel = new St.Label({
            text: _('Spotify is not running'),
            style_class: 'sdc-not-running',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 170,
        });
        vbox.add_child(this._notRunningLabel);

        this.menu.addMenuItem(item);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._raiseItem = this.menu.addAction(_('Show Spotify'), () => this._player.raise());
        this._launchItem = this.menu.addAction(_('Launch Spotify'), () => this._launchSpotify());
    }

    _launchSpotify() {
        try {
            const app = Gio.DesktopAppInfo.new('spotify.desktop') ??
                Gio.DesktopAppInfo.new('com.spotify.Client.desktop');
            if (app)
                app.launch([], global.create_app_launch_context(0, -1));
            else
                GLib.spawn_command_line_async('spotify');
        } catch (e) {
            console.warn(`[spotify-dock-controller] launching Spotify: ${e.message}`);
        }
    }

    _scheduleSeek() {
        if (this._seekDelayId)
            GLib.source_remove(this._seekDelayId);
        this._elapsedLabel.text = formatTime(this._slider.value * this._player.lengthUs);
        this._seekDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._seekDelayId = 0;
            this._seekToSlider();
            return GLib.SOURCE_REMOVE;
        });
    }

    _seekToSlider() {
        const p = this._player;
        if (!p.running || !p.canSeek || p.lengthUs <= 0)
            return;
        p.seekTo(this._slider.value * p.lengthUs);
        this._updatePosition();
    }

    // --- Mise à jour de l'affichage --------------------------------------------

    _sync() {
        const p = this._player;
        const running = p.running;
        const hideWhenClosed = this._settings.get_boolean('hide-when-closed');

        // Visibilité / état grisé de l'indicateur
        this.visibleWanted = running || !hideWhenClosed;
        this.container.visible = this.visibleWanted && !this._overviewHidden;
        this._box.opacity = running ? 255 : 128;

        // Texte
        const showText = this._settings.get_boolean('show-text');
        const maxLen = this._settings.get_int('max-text-length');
        let text = '';
        if (running && p.title)
            text = p.artist ? `${p.title} — ${p.artist}` : p.title;
        else if (!running)
            text = 'Spotify';
        this._label.text = truncate(text, maxLen);
        this._label.visible = showText && text !== '';

        // Mini-pochette : remplace l'icône d'app quand disponible
        const showMini = this._settings.get_boolean('show-mini-art');
        this._miniArt.visible = showMini && running && !!this._currentArt;
        this._icon.visible = !this._miniArt.visible;

        // Popup
        this._titleLabel.text = running ? p.title || '—' : '';
        this._artistLabel.text = running ? p.artist : '';
        this._albumLabel.text = running ? p.album : '';
        this._titleLabel.visible = running;
        this._artistLabel.visible = running && !!p.artist;
        this._albumLabel.visible = running && !!p.album;
        this._slider.visible = running;
        this._slider.reactive = running && p.canSeek;
        this._elapsedLabel.get_parent().visible = running;
        this._playBtn.child.icon_name = p.playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prevBtn.reactive = running && p.canGoPrevious;
        this._nextBtn.reactive = running && p.canGoNext;
        this._playBtn.reactive = running && p.canControl;
        for (const b of [this._prevBtn, this._nextBtn, this._playBtn])
            b.opacity = b.reactive ? 255 : 100;
        this._shuffleBtn.visible = running && p.shuffle !== null;
        this._repeatBtn.visible = running && p.loopStatus !== null;
        this._setChecked(this._shuffleBtn, p.shuffle === true);
        this._setChecked(this._repeatBtn, p.loopStatus === 'Playlist' || p.loopStatus === 'Track');
        this._repeatBtn.child.icon_name = p.loopStatus === 'Track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._prevBtn.get_parent().visible = running;
        this._notRunningLabel.visible = !running;
        this._raiseItem.visible = running;
        this._launchItem.visible = !running;
        this._cover.visible = running;
        this._durationLabel.text = formatTime(p.lengthUs);

        this._updateArt();
        this._updatePosition();
        this._updatePolling();
    }

    _setChecked(button, checked) {
        button.opacity = checked ? 255 : 150;
        if (checked)
            button.add_style_pseudo_class('checked');
        else
            button.remove_style_pseudo_class('checked');
    }

    /** Appelé par le placeur (mode dock) quand la vue d'ensemble s'ouvre/ferme. */
    setOverviewHidden(hidden) {
        this._overviewHidden = hidden;
        this.container.visible = this.visibleWanted && !hidden;
        if (hidden)
            this.menu.close();
    }

    _updateArt() {
        const url = this._player.running ? this._player.artUrl : '';
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        const token = ++this._artToken;
        this._setArt(null);
        if (!url)
            return;
        this._artCache.lookup(url).then(icon => {
            // ignore les réponses obsolètes (piste changée entre-temps) ou
            // arrivées après destruction
            if (token !== this._artToken || this._destroyed)
                return;
            this._setArt(icon);
        });
    }

    _setArt(icon) {
        this._currentArt = icon;
        if (icon) {
            this._cover.gicon = icon;
            this._cover.remove_style_class_name('sdc-cover-placeholder');
            this._cover.opacity = 255;
        } else {
            this._cover.gicon = null;
            this._cover.icon_name = 'audio-x-generic-symbolic';
            this._cover.add_style_class_name('sdc-cover-placeholder');
            this._cover.opacity = 90;
        }
        this._miniArt.gicon = icon;
        const showMini = this._settings.get_boolean('show-mini-art');
        this._miniArt.visible = showMini && this._player.running && !!icon;
        this._icon.visible = !this._miniArt.visible;
    }

    _updatePosition() {
        if (this._dragging || this._seekDelayId)
            return;
        const p = this._player;
        const len = p.lengthUs;
        const pos = Math.min(p.positionUs, len || p.positionUs);
        this._updatingSlider = true;
        this._slider.value = len > 0 ? Math.max(0, Math.min(1, pos / len)) : 0;
        this._updatingSlider = false;
        this._elapsedLabel.text = formatTime(pos);
        this._durationLabel.text = formatTime(len);
    }

    // Polling de Position uniquement quand le popup est ouvert et que
    // Spotify tourne : la position n'est affichée nulle part ailleurs.
    _updatePolling() {
        const want = this.menu.isOpen && this._player.running;
        if (want && !this._pollId) {
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_S, () => {
                if (this._player.playing && !this._dragging)
                    this._player.refreshPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._seekDelayId) {
            GLib.source_remove(this._seekDelayId);
            this._seekDelayId = 0;
        }
        this._player.disconnectObject(this);
        this._settings.disconnectObject(this);
        super._onDestroy();
    }
});
