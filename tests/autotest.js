// Script d'automatisation exécuté DANS un gnome-shell headless isolé.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'spotify-dock-controller@lsarazin';
const OUT = GLib.getenv('SDC_OUT');
export const METRICS = {};
let fails = 0;
const log = m => print(`[TEST] ${m}`);
const check = (cond, m) => { if (!cond) fails++; print(`[${cond ? 'PASS' : 'FAIL'}] ${m}`); };
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return false; }));
async function waitFor(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (fn()) return true; } catch {} await sleep(100); } return false; }
async function shot(name) {
  const f = Gio.File.new_for_path(`${OUT}/${name}.png`);
  const s = f.replace(null, false, Gio.FileCreateFlags.NONE, null);
  await new Shell.Screenshot().screenshot(false, s); s.close(null); log(`screenshot ${name}.png`);
}
const ext = () => Main.extensionManager.lookup(UUID);
const inst = () => ext()?.stateObj;
const ext_ = (a) => { const e = a.get_transformed_extents(); return {x: e.origin.x, y: e.origin.y, w: e.size.width, h: e.size.height}; };
function dockBg() {
  const c = Main.layoutManager.uiGroup.get_children().find(a => a.name === 'dashtodockContainer');
  return c?.dash?._background ?? null;
}
async function playerGet(name) {
  const r = await Gio.DBus.session.call('org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
    new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', name]), null, 0, 2000, null);
  return r.deepUnpack()[0].recursiveUnpack();
}

export async function run() {
  await sleep(1500);
  const e = ext();
  log(`extension state=${e?.state} error=${e?.error ?? ''}`);
  check(e && e.state === 1, 'extension ENABLED');
  const dockExt = Main.extensionManager.lookup('ubuntu-dock@ubuntu.com');
  log(`ubuntu-dock state=${dockExt?.state}`);
  const s = inst()._settings;
  s.set_boolean('debug', true);

  check(await waitFor(() => inst()._player.running), 'faux Spotify détecté (bus_watch_name)');
  const ind = () => inst()._indicator;
  await sleep(500);
  log(`label="${ind()._label.text}" visible=${ind().container.visible}`);
  check(ind()._label.text === 'Count Me Out — Kendrick Lamar', 'texte Titre — Artiste');

  // ---- mode dock-right
  const bg = dockBg();
  check(!!bg, 'dock ubuntu-dock trouvé (dash._background)');
  const w = inst()._placer._wrapper;
  await sleep(300);
  const d = bg ? ext_(bg) : null, r = ext_(w);
  log(`dock=${JSON.stringify(d)} widget=${JSON.stringify(r)}`);
  if (d) {
    check(Math.abs(r.x - (d.x + d.w + 8)) <= 1, 'dock-right: x = droite du dock + 8');
    check(Math.abs(r.y - d.y) <= 1 && Math.abs(r.h - d.h) <= 1, 'aligné verticalement / même hauteur que le dock');
    const ib = ext_(ind());
    check(Math.abs(ib.h - d.h) <= 1, `bouton remplit la hauteur du dock (h=${ib.h})`);
  }
  check(await waitFor(() => inst()._indicator._currentArt !== null, 8000), 'pochette téléchargée/cachée');
  log(`cover gicon=${ind()._cover.gicon?.to_string?.()}`);
  const cacheDir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), UUID]));
  const en = cacheDir.enumerate_children('standard::name,standard::size', 0, null); let info, n = 0;
  while ((info = en.next_file(null))) { n++; log(`cache: ${info.get_name()} ${info.get_size()} o`); }
  check(n === 1, 'un fichier dans ~/.cache/<uuid>/ (nom = sha256 de l\'URL)');
  await shot('01-dock-right');

  // ---- vrais événements pointeur (périphérique virtuel)
  const seat = Clutter.get_default_backend().get_default_seat();
  const vp = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
  const now = () => GLib.get_monotonic_time();
  async function click(x, y, button) {
    vp.notify_absolute_motion(now(), x, y); await sleep(150);
    vp.notify_button(now(), button, Clutter.ButtonState.PRESSED); await sleep(60);
    vp.notify_button(now(), button, Clutter.ButtonState.RELEASED); await sleep(300);
  }
  { const b = ext_(ind()); const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const st0 = inst()._player.status;
    await click(cx, cy, Clutter.BUTTON_MIDDLE); await sleep(300);
    check(inst()._player.status !== st0 && !ind().menu.isOpen, `vrai clic milieu -> play/pause sans ouvrir le menu (${st0} -> ${inst()._player.status})`);
    await click(cx, cy, Clutter.BUTTON_MIDDLE); await sleep(300);
    await click(cx, cy, Clutter.BUTTON_PRIMARY); await sleep(500);
    check(ind().menu.isOpen, 'vrai clic gauche -> popup ouvert');
    const sl = ext_(ind()._slider);
    await click(sl.x + sl.w * 0.75, sl.y + sl.h / 2, Clutter.BUTTON_PRIMARY); await sleep(400);
    const p75 = await playerGet('Position');
    check(Math.abs(p75 / 283642000 - 0.75) < 0.05, `vrai clic sur la barre -> seek ~75% (${(p75 / 283642000).toFixed(3)})`);
    check(ind().menu.isOpen, 'popup reste ouvert après clic dans la barre');
    await click(200, 300, Clutter.BUTTON_PRIMARY); await sleep(500);
    check(!ind().menu.isOpen, 'clic à l\'extérieur -> popup fermé');
  }

  ind().menu.open(); await sleep(600);
  const m = ext_(ind().menu.actor), ir = ext_(ind());
  log(`menu=${JSON.stringify(m)} indicator=${JSON.stringify(ir)}`);
  check(m.y + m.h <= ir.y + 2, 'popup ouvert vers le HAUT (au-dessus du widget)');
  check(ind()._pollId !== 0, 'polling actif quand popup ouvert');
  await shot('02-dock-right-menu');

  // seek via slider (changement de valeur hors drag -> seek différé)
  ind()._slider.value = 0.5; await sleep(700);
  const p = await playerGet('Position');
  log(`position après seek=${p}`);
  check(Math.abs(p - 283642000 / 2) < 3e6, 'SetPosition(trackid, pos) appliqué');
  check(Math.abs(ind()._slider.value - 0.5) < 0.05, 'slider resynchronisé (Seeked)');

  ind()._playBtn.emit('clicked', 1); await sleep(400);
  check(inst()._player.status === 'Paused', 'bouton play/pause -> Paused');
  ind()._onClick(2); await sleep(400);
  check(inst()._player.status === 'Playing', 'clic milieu -> Playing');
  ind()._shuffleBtn.emit('clicked', 1); await sleep(500);
  check(inst()._player.shuffle === true, 'shuffle basculé (relu via Get)');
  ind()._repeatBtn.emit('clicked', 1); await sleep(500);
  check(inst()._player.loopStatus === 'Playlist', 'repeat -> Playlist');
  ind()._nextBtn.emit('clicked', 1); await sleep(500);
  log(`label après next="${ind()._label.text}"`);
  check([...ind()._label.text].length <= 40 && ind()._label.text.endsWith('…'), 'troncature à 40 car.');
  await shot('03-next-track-menu');
  ind().menu.close(); await sleep(300);
  check(ind()._pollId === 0, 'polling arrêté popup fermé');

  // ---- dock-left
  s.set_string('placement', 'dock-left'); await sleep(600);
  { const r2 = ext_(inst()._placer._wrapper), d2 = ext_(dockBg());
    log(`dock-left widget=${JSON.stringify(r2)}`);
    check(Math.abs(r2.x + r2.w + 8 - d2.x) <= 1, 'dock-left: bord droit = gauche du dock - 8'); }
  s.set_int('dock-offset', 40); await sleep(400);
  { const r2 = ext_(inst()._placer._wrapper), d2 = ext_(dockBg());
    check(Math.abs(r2.x + r2.w + 40 - d2.x) <= 1, 'offset 40 appliqué à chaud'); }
  s.set_int('dock-offset', 8);
  await shot('04-dock-left');

  // overview
  s.set_boolean('hide-in-overview', true);
  Main.overview.show(); await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 5000); await sleep(300);
  check(!ind().container.visible, 'masqué en vue d\'ensemble');
  Main.overview.hide(); await waitFor(() => !Main.overview.visible, 5000); await sleep(300);
  check(ind().container.visible, 'réaffiché après vue d\'ensemble');

  // ---- panel
  s.set_string('placement', 'panel-right'); await sleep(500);
  check(Main.panel.statusArea['spotify-dock-controller'] === ind(), 'ajouté à Main.panel.statusArea (droite)');
  check(Main.panel._rightBox.contains(ind()), 'dans _rightBox');
  check(!Main.layoutManager.uiGroup.get_children().some(a => a.name === 'spotifyDockControllerWrapper'), 'wrapper dock retiré');
  ind().menu.open(); await sleep(600);
  { const m2 = ext_(ind().menu.actor), i2 = ext_(ind()); check(m2.y >= i2.y + i2.h - 2, 'popup barre : vers le bas'); }
  await shot('05-panel-right-menu');
  ind().menu.close();
  s.set_string('placement', 'panel-center'); s.set_int('panel-index', 1); await sleep(500);
  check(Main.panel._centerBox.contains(ind()), 'panel-center');
  s.set_boolean('show-mini-art', true); await sleep(300);
  ind()._prevBtn.emit('clicked', 1); await sleep(800);
  check(ind()._miniArt.visible && !ind()._icon.visible, 'mini-pochette affichée (piste avec artUrl, depuis le cache)');
  s.set_string('placement', 'panel-left'); await sleep(500);
  check(Main.panel._leftBox.contains(ind()), 'panel-left');
  await shot('06-panel-left-miniart');

  // ---- Spotify quitte
  await Gio.DBus.session.call('org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', 'Quit', null, null, 0, 2000, null);
  check(await waitFor(() => !inst()._player.running, 3000), 'disparition détectée');
  check(!ind().container.visible, 'masqué quand Spotify fermé');
  s.set_boolean('hide-when-closed', false); await sleep(200);
  check(ind().container.visible && ind()._box.opacity === 128, 'grisé quand option désactivée');
  s.set_string('placement', 'dock-right'); await sleep(500);
  await shot('07-dock-right-closed');

  // ---- Spotify (re)démarre après l'activation
  s.set_boolean('hide-when-closed', true);
  GLib.spawn_async(null, ['gjs', '-m', GLib.getenv('SDC_FAKE'), GLib.getenv('SDC_ART')], null, GLib.SpawnFlags.SEARCH_PATH, null);
  check(await waitFor(() => inst()._player.running && ind().container.visible, 5000), 'Spotify relancé -> réapparition (NameOwnerChanged)');
  log(`label après relance="${ind()._label.text}"`);

  // ---- fallback sans dock
  await Main.extensionManager.disableExtension('ubuntu-dock@ubuntu.com'); await sleep(800);
  { const r3 = ext_(inst()._placer._wrapper); const mon = Main.layoutManager.primaryMonitor;
    log(`fallback widget=${JSON.stringify(r3)}`);
    check(Math.abs(r3.x - (mon.x + mon.width / 2 + 8)) <= 1 && r3.y + r3.h <= mon.y + mon.height, 'dock absent -> fallback centre-bas + offset'); }
  await shot('07b-fallback-no-dock');
  await Main.extensionManager.enableExtension('ubuntu-dock@ubuntu.com'); await sleep(1500);
  { const r4 = ext_(inst()._placer._wrapper), d4 = ext_(dockBg());
    check(Math.abs(r4.x - (d4.x + d4.w + 8)) <= 1, 'dock réactivé -> recollé au dock'); }

  // ---- prefs (fenêtre Adw dans la session headless)
  Main.extensionManager.openExtensionPrefs(UUID, '', {});
  const gotWin = await waitFor(() => global.get_window_actors().some(a => (a.meta_window.get_title() ?? '').includes('Spotify')), 15000);
  check(gotWin, 'fenêtre de préférences ouverte');
  await sleep(1500);
  log(`windows: ${global.get_window_actors().map(a => a.meta_window.get_title()).join(' | ')}`);
  await shot('08-prefs');
  s.set_string('placement', 'panel-center'); await sleep(800);
  await shot('09-prefs-after-change');

  // ---- disable / enable
  const before = Main.layoutManager.uiGroup.get_n_children();
  await Main.extensionManager.disableExtension(UUID); await sleep(500);
  check(ext().state !== 1, `désactivée (state=${ext().state})`);
  check(!Main.layoutManager.uiGroup.get_children().some(a => a.name === 'spotifyDockControllerWrapper'), 'aucun wrapper après disable');
  check(!Main.panel.statusArea['spotify-dock-controller'], 'statusArea nettoyé');
  check(!Main.layoutManager._trackedActors.some(t => t.actor.name === 'spotifyDockControllerWrapper'), 'chrome dé-traqué');
  log(`uiGroup children before=${before} after=${Main.layoutManager.uiGroup.get_n_children()}`);
  await Main.extensionManager.enableExtension(UUID); await sleep(800);
  check(ext().state === 1, 'ré-activée');
  await Main.extensionManager.disableExtension(UUID); await sleep(300);
  log(`FIN fails=${fails}`);
}
