// Cache disque des pochettes (mpris:artUrl).
//
// Spotify fournit des URL https://i.scdn.co/image/<id>. On les télécharge en
// asynchrone avec Soup 3 dans ~/.cache/<uuid>/<sha256(url)>, puis on renvoie
// un Gio.FileIcon. Les URL file:// sont utilisées telles quelles.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const MAX_CACHED_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

export class ArtCache {
    constructor(uuid) {
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), uuid]));
        this._session = new Soup.Session({
            timeout: 15,
            user_agent: 'spotify-dock-controller (GNOME Shell extension)',
        });
        this._cancellable = new Gio.Cancellable();
        this._memo = new Map(); // url -> Gio.FileIcon
        this._pending = new Map(); // url -> Promise
        this._prune().catch(() => {});
    }

    _fileFor(url) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        return this._dir.get_child(hash);
    }

    /**
     * @param {string} url
     * @returns {Promise<Gio.Icon|null>}
     */
    lookup(url) {
        if (!url)
            return Promise.resolve(null);
        if (this._memo.has(url))
            return Promise.resolve(this._memo.get(url));
        if (url.startsWith('file://')) {
            const icon = new Gio.FileIcon({file: Gio.File.new_for_uri(url)});
            this._memo.set(url, icon);
            return Promise.resolve(icon);
        }
        if (!/^https?:\/\//.test(url))
            return Promise.resolve(null);

        const file = this._fileFor(url);
        if (file.query_exists(null)) {
            const icon = new Gio.FileIcon({file});
            this._memo.set(url, icon);
            return Promise.resolve(icon);
        }

        if (!this._pending.has(url)) {
            const p = this._download(url, file)
                .then(icon => {
                    if (icon)
                        this._memo.set(url, icon);
                    return icon;
                })
                .catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`[spotify-dock-controller] pochette ${url}: ${e.message}`);
                    return null;
                })
                .finally(() => this._pending.delete(url));
            this._pending.set(url, p);
        }
        return this._pending.get(url);
    }

    async _download(url, file) {
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            return null;
        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_LOW, this._cancellable);
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${msg.get_status()}`);
        if (!bytes || bytes.get_size() === 0 || bytes.get_size() > MAX_BYTES)
            throw new Error('réponse vide ou trop grosse');

        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        // replace_contents écrit dans un fichier temporaire puis renomme :
        // pas de fichier tronqué visible en cas d'interruption.
        await file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
        return new Gio.FileIcon({file});
    }

    /** Garde au plus MAX_CACHED_FILES fichiers (les plus récents). */
    async _prune() {
        if (!this._dir.query_exists(null))
            return;
        const enumerator = await this._dir.enumerate_children_async(
            'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable);
        const infos = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const batch = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, this._cancellable);
            if (!batch.length)
                break;
            infos.push(...batch);
        }
        if (infos.length <= MAX_CACHED_FILES)
            return;
        infos.sort((a, b) =>
            b.get_attribute_uint64('time::modified') - a.get_attribute_uint64('time::modified'));
        for (const info of infos.slice(MAX_CACHED_FILES)) {
            // eslint-disable-next-line no-await-in-loop
            await this._dir.get_child(info.get_name())
                .delete_async(GLib.PRIORITY_LOW, this._cancellable)
                .catch(() => {});
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._memo.clear();
        this._pending.clear();
    }
}
