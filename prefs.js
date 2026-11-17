import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Marque une chaîne pour xgettext sans la traduire : _() n'est utilisable
// qu'une fois l'extension chargée, la traduction se fait à l'affichage.
const N_ = s => s;

const PLACEMENTS = [
    ['dock-left', N_('Bottom, left of the dock')],
    ['dock-right', N_('Bottom, right of the dock')],
    ['panel-left', N_('Top bar — left')],
    ['panel-center', N_('Top bar — center')],
    ['panel-right', N_('Top bar — right')],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step = 1) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class SpotifyDockControllerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Placement -------------------------------------------------------
        const placementGroup = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('Applied immediately, without restarting the session.'),
        });
        page.add(placementGroup);

        const placementRow = new Adw.ComboRow({
            title: _('Location'),
            model: Gtk.StringList.new(PLACEMENTS.map(([, label]) => _(label))),
        });
        const syncCombo = () => {
            const idx = PLACEMENTS.findIndex(([id]) => id === settings.get_string('placement'));
            if (idx >= 0 && placementRow.selected !== idx)
                placementRow.selected = idx;
        };
        syncCombo();
        placementRow.connect('notify::selected', () => {
            const id = PLACEMENTS[placementRow.selected]?.[0];
            if (id && settings.get_string('placement') !== id)
                settings.set_string('placement', id);
        });
        placementGroup.add(placementRow);

        const indexRow = spinRow(settings, 'panel-index', _('Position in the top bar area'),
            _('Index inside the top bar box (0 = first)'), 0, 50);
        placementGroup.add(indexRow);

        const offsetRow = spinRow(settings, 'dock-offset', _('Horizontal offset from the dock'),
            _('In pixels (if the dock is not found: from the bottom center of the screen)'), -2000, 2000);
        placementGroup.add(offsetRow);

        const overviewRow = switchRow(settings, 'hide-in-overview',
            _('Hide in the Activities overview'), _('Dock locations only'));
        placementGroup.add(overviewRow);

        const syncSensitivity = () => {
            const inDock = settings.get_string('placement').startsWith('dock-');
            indexRow.sensitive = !inDock;
            offsetRow.sensitive = inDock;
            overviewRow.sensitive = inDock;
        };
        syncSensitivity();
        const placementChangedId = settings.connect('changed::placement', () => {
            syncCombo();
            syncSensitivity();
        });
        window.connect('close-request', () => {
            settings.disconnect(placementChangedId);
            return false;
        });

        // --- Affichage -------------------------------------------------------
        const displayGroup = new Adw.PreferencesGroup({title: _('Display')});
        page.add(displayGroup);
        displayGroup.add(switchRow(settings, 'show-text', _('Show “Title — Artist”')));
        const lenRow = spinRow(settings, 'max-text-length', _('Maximum text length'),
            _('In characters, truncated with “…”'), 5, 200);
        settings.bind('show-text', lenRow, 'sensitive', Gio.SettingsBindFlags.GET);
        displayGroup.add(lenRow);
        displayGroup.add(switchRow(settings, 'show-mini-art', _('Mini album art in the indicator'),
            _('Replaces the icon once the album art is available')));
        displayGroup.add(switchRow(settings, 'hide-when-closed', _('Hide when Spotify is closed'),
            _('Otherwise the indicator stays visible, greyed out')));

        // --- Interaction ------------------------------------------------------
        const inputGroup = new Adw.PreferencesGroup({title: _('Interaction')});
        page.add(inputGroup);
        inputGroup.add(switchRow(settings, 'middle-click-play-pause', _('Middle click = play/pause')));

        // --- Avancé -----------------------------------------------------------
        const advGroup = new Adw.PreferencesGroup({title: _('Advanced')});
        page.add(advGroup);
        advGroup.add(switchRow(settings, 'debug', _('Placement logs'),
            // TRANSLATORS: keep the command unchanged
            _('Shown with: journalctl --user -f -o cat /usr/bin/gnome-shell')));

        // garder une référence tant que la fenêtre vit
        window._settings = settings;
    }
}
