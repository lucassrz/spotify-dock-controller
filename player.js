// Client MPRIS minimal dédié à Spotify.
//
// - Suit l'apparition/disparition du nom de bus via Gio.bus_watch_name
//   (qui s'appuie sur NameOwnerChanged).
// - Proxy D-Bus sur org.mpris.MediaPlayer2.Player, mis à jour via
//   PropertiesChanged + signal Seeked.
// - Spotify n'émet pas PropertiesChanged pour Position (et pas toujours pour
//   Shuffle/LoopStatus) : la position est lue explicitement via
//   org.freedesktop.DBus.Properties.Get, à la demande (polling piloté par l'UI).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export const BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const PlayerIfaceXml = `
<node>
  <interface name="${PLAYER_IFACE}">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIfaceXml);

function unpackMetadata(variant) {
    // variant: a{sv} déjà déballé au premier niveau par le wrapper -> objet
    // dont les valeurs sont des GLib.Variant.
    const meta = {};
    if (!variant)
        return meta;
    for (const [key, value] of Object.entries(variant)) {
        try {
            meta[key] = value instanceof GLib.Variant ? value.recursiveUnpack() : value;
        } catch {
            // valeur exotique ignorée
        }
    }
    return meta;
}

function joinArtists(value) {
    if (Array.isArray(value))
        return value.filter(Boolean).join(', ');
    return typeof value === 'string' ? value : '';
}

/**
 * Signaux émis :
 *  - 'running-changed' (running: bool)
 *  - 'changed'         () métadonnées / statut / shuffle / repeat modifiés
 *  - 'position'        (positionUs: number)
 */
export class SpotifyPlayer extends EventEmitter {
    constructor() {
        super();
        this._running = false;
        this._proxy = null;
        this._cancellable = null;
        this._seekedId = 0;
        this._propsChangedId = 0;
        this._resetState();

        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onNameAppeared(),
            () => this._onNameVanished());
    }

    _resetState() {
        this.status = 'Stopped';
        this.title = '';
        this.artist = '';
        this.album = '';
        this.artUrl = '';
        this.trackId = '';
        this.lengthUs = 0;
        this.positionUs = 0;
        this.shuffle = null; // null = non exposé
        this.loopStatus = null;
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.canSeek = false;
        this.canControl = false;
    }

    get running() {
        return this._running;
    }

    get playing() {
        return this.status === 'Playing';
    }

    async _onNameAppeared() {
        this._disconnectProxy();
        this._cancellable = new Gio.Cancellable();
        try {
            const proxy = await PlayerProxy.newAsync(
                Gio.DBus.session, BUS_NAME, OBJECT_PATH, this._cancellable);
            if (this._cancellable?.is_cancelled() || this._watchId === 0)
                return;
            this._proxy = proxy;
            this._propsChangedId = proxy.connect('g-properties-changed',
                () => this._syncFromProxy());
            this._seekedId = proxy.connectSignal('Seeked', (_p, _sender, [pos]) => {
                this.positionUs = Number(pos);
                this.emit('position', this.positionUs);
            });
            this._running = true;
            this._syncFromProxy();
            this.emit('running-changed', true);
            this.refreshPosition();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[spotify-dock-controller] proxy MPRIS: ${e.message}`);
        }
    }

    _onNameVanished() {
        const wasRunning = this._running;
        this._disconnectProxy();
        this._running = false;
        this._resetState();
        if (wasRunning)
            this.emit('running-changed', false);
        this.emit('changed');
    }

    _disconnectProxy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proxy) {
            if (this._propsChangedId)
                this._proxy.disconnect(this._propsChangedId);
            if (this._seekedId)
                this._proxy.disconnectSignal(this._seekedId);
        }
        this._propsChangedId = 0;
        this._seekedId = 0;
        this._proxy = null;
    }

    _syncFromProxy() {
        const p = this._proxy;
        if (!p)
            return;
        const meta = unpackMetadata(p.Metadata);
        const oldTrack = this.trackId;

        this.status = p.PlaybackStatus ?? 'Stopped';
        this.title = meta['xesam:title'] ?? '';
        this.artist = joinArtists(meta['xesam:artist']) || joinArtists(meta['xesam:albumArtist']);
        this.album = meta['xesam:album'] ?? '';
        this.artUrl = meta['mpris:artUrl'] ?? '';
        this.trackId = meta['mpris:trackid'] ?? '';
        this.lengthUs = Number(meta['mpris:length'] ?? 0);
        this.shuffle = typeof p.Shuffle === 'boolean' ? p.Shuffle : null;
        this.loopStatus = typeof p.LoopStatus === 'string' ? p.LoopStatus : null;
        this.canGoNext = !!p.CanGoNext;
        this.canGoPrevious = !!p.CanGoPrevious;
        this.canSeek = !!p.CanSeek;
        this.canControl = p.CanControl !== false;

        if (oldTrack !== this.trackId)
            this.positionUs = 0;

        this.emit('changed');
    }

    async _getProperty(name) {
        const reply = await Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, name]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 2000, this._cancellable);
        return reply.deepUnpack()[0].recursiveUnpack();
    }

    async _setProperty(name, variant) {
        await Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, variant]),
            null, Gio.DBusCallFlags.NONE, 2000, this._cancellable);
    }

    /** Lit la position réelle (Spotify ne la notifie pas). */
    async refreshPosition() {
        if (!this._running)
            return;
        try {
            const pos = Number(await this._getProperty('Position'));
            if (!Number.isFinite(pos))
                return;
            this.positionUs = pos;
            this.emit('position', pos);
        } catch (e) {
            this._logCallError('Position', e);
        }
    }

    /** Relit Shuffle / LoopStatus, que Spotify ne notifie pas toujours. */
    async refreshExtras() {
        if (!this._running)
            return;
        let changed = false;
        for (const [name, field, type] of [['Shuffle', 'shuffle', 'boolean'], ['LoopStatus', 'loopStatus', 'string']]) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const v = await this._getProperty(name);
                if (typeof v === type && this[field] !== v) {
                    this[field] = v;
                    changed = true;
                }
            } catch {
                // propriété non exposée : on garde la valeur actuelle
            }
        }
        if (changed)
            this.emit('changed');
    }

    _logCallError(what, e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        console.debug(`[spotify-dock-controller] ${what}: ${e?.message}`);
    }

    _call(method) {
        if (!this._proxy)
            return;
        this._proxy[`${method}Remote`]((_res, err) => {
            if (err)
                this._logCallError(method, err);
        });
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    /** @param {number} positionUs position absolue en microsecondes */
    seekTo(positionUs) {
        if (!this._proxy || !this.canSeek || !this.trackId)
            return;
        const pos = Math.max(0, Math.min(Math.round(positionUs), this.lengthUs || positionUs));
        this.positionUs = pos;
        this._proxy.SetPositionRemote(this.trackId, pos, (_res, err) => {
            if (err)
                this._logCallError('SetPosition', err);
        });
    }

    async toggleShuffle() {
        if (this.shuffle === null)
            return;
        try {
            await this._setProperty('Shuffle', GLib.Variant.new_boolean(!this.shuffle));
        } catch (e) {
            this._logCallError('Shuffle', e);
        }
        await this.refreshExtras();
    }

    async cycleLoop() {
        if (this.loopStatus === null)
            return;
        const order = ['None', 'Playlist', 'Track'];
        const next = order[(order.indexOf(this.loopStatus) + 1) % order.length];
        try {
            await this._setProperty('LoopStatus', GLib.Variant.new_string(next));
        } catch (e) {
            this._logCallError('LoopStatus', e);
        }
        await this.refreshExtras();
    }

    raise() {
        if (!this._running)
            return;
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, ROOT_IFACE, 'Raise',
            null, null, Gio.DBusCallFlags.NONE, 2000, null)
            .catch(e => this._logCallError('Raise', e));
    }

    destroy() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._disconnectProxy();
        this._running = false;
        this.disconnectAll();
    }
}
