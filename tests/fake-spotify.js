// Faux lecteur MPRIS imitant Spotify (Position non notifiée, Shuffle/Loop sans PropertiesChanged).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const XML = `<node>
<interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="Identity" type="s" access="read"/>
</interface>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="PlayPause"/>
  <method name="SetPosition"><arg direction="in" type="o"/><arg direction="in" type="x"/></method>
  <signal name="Seeked"><arg type="x"/></signal>
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
</interface></node>`;
const ART = ARGV[0] || '';
const tracks = [
  {id: '/com/spotify/track/aaa', title: 'Count Me Out', artist: ['Kendrick Lamar'], album: 'Mr. Morale & The Big Steppers', len: 283642000, art: ART},
  {id: '/com/spotify/track/bbb', title: 'Un titre vraiment très long pour tester la troncature du texte', artist: ['Artiste A', 'Artiste B'], album: 'Album B', len: 200000000, art: ''},
];
let idx = 0, status = 'Playing', shuffle = false, loop = 'None';
let basePos = 10e6, baseTime = GLib.get_monotonic_time();
const pos = () => status === 'Playing' ? basePos + (GLib.get_monotonic_time() - baseTime) : basePos;
const setPos = p => { basePos = p; baseTime = GLib.get_monotonic_time(); };
const meta = () => { const t = tracks[idx]; const m = {
  'mpris:trackid': new GLib.Variant('o', t.id), 'mpris:length': new GLib.Variant('x', t.len),
  'xesam:title': new GLib.Variant('s', t.title), 'xesam:artist': new GLib.Variant('as', t.artist),
  'xesam:album': new GLib.Variant('s', t.album)}; if (t.art) m['mpris:artUrl'] = new GLib.Variant('s', t.art); return m; };
const loopMain = new GLib.MainLoop(null, false);
const node = Gio.DBusNodeInfo.new_for_xml(XML);
let conn;
function changed(props) {
  conn.emit_signal(null, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
    new GLib.Variant('(sa{sv}as)', ['org.mpris.MediaPlayer2.Player', props, []]));
}
function getProp(iface, name) {
  if (iface === 'org.mpris.MediaPlayer2') return new GLib.Variant('s', 'Spotify');
  switch (name) {
  case 'PlaybackStatus': return new GLib.Variant('s', status);
  case 'LoopStatus': return new GLib.Variant('s', loop);
  case 'Shuffle': return new GLib.Variant('b', shuffle);
  case 'Metadata': return new GLib.Variant('a{sv}', meta());
  case 'Position': return new GLib.Variant('x', Math.round(pos()));
  default: return new GLib.Variant('b', true);
  }
}
Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.spotify', Gio.BusNameOwnerFlags.NONE, c => {
  conn = c;
  for (const iface of node.interfaces) {
    c.register_object('/org/mpris/MediaPlayer2', iface, (cn, sender, path, ifn, method, params, inv) => {
      print(`fake-spotify: ${method} ${params ? params.print(true) : ''}`);
      switch (method) {
      case 'PlayPause': setPos(pos()); status = status === 'Playing' ? 'Paused' : 'Playing'; changed({PlaybackStatus: new GLib.Variant('s', status)}); break;
      case 'Next': case 'Previous': idx = (idx + 1) % tracks.length; setPos(0); changed({Metadata: new GLib.Variant('a{sv}', meta())}); break;
      case 'SetPosition': { const [tid, p] = params.deepUnpack(); if (tid === tracks[idx].id) { setPos(p); c.emit_signal(null, path, ifn, 'Seeked', new GLib.Variant('(x)', [p])); } break; }
      case 'Quit': inv.return_value(null); GLib.timeout_add(0, 100, () => { loopMain.quit(); return false; }); return;
      }
      inv.return_value(null);
    }, (cn, s, p, ifn, name) => getProp(ifn, name),
    (cn, s, p, ifn, name, value) => { print(`fake-spotify: set ${name}=${value.print(true)}`);
      if (name === 'Shuffle') shuffle = value.unpack(); else if (name === 'LoopStatus') loop = value.unpack(); return true; });
  }
}, () => print('fake-spotify: name acquired'), () => { print('fake-spotify: name lost'); loopMain.quit(); });
loopMain.run();
