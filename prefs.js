import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PLACEMENTS = [
    ['dock-left', 'En bas, à gauche du dock'],
    ['dock-right', 'En bas, à droite du dock'],
    ['panel-left', 'Barre du haut — gauche'],
    ['panel-center', 'Barre du haut — centre'],
    ['panel-right', 'Barre du haut — droite'],
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
            title: 'Réglages',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Placement -------------------------------------------------------
        const placementGroup = new Adw.PreferencesGroup({
            title: 'Placement',
            description: 'Appliqué immédiatement, sans relancer la session.',
        });
        page.add(placementGroup);

        const placementRow = new Adw.ComboRow({
            title: 'Emplacement',
            model: Gtk.StringList.new(PLACEMENTS.map(([, label]) => label)),
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

        const indexRow = spinRow(settings, 'panel-index', 'Position dans la zone',
            'Index dans la zone de la barre du haut (0 = premier)', 0, 50);
        placementGroup.add(indexRow);

        const offsetRow = spinRow(settings, 'dock-offset', 'Décalage par rapport au dock',
            'En pixels (si le dock est introuvable : par rapport au centre-bas de l\'écran)', -2000, 2000);
        placementGroup.add(offsetRow);

        const overviewRow = switchRow(settings, 'hide-in-overview',
            'Masquer en vue d\'ensemble', 'Mode « à côté du dock » uniquement');
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
        const displayGroup = new Adw.PreferencesGroup({title: 'Affichage'});
        page.add(displayGroup);
        displayGroup.add(switchRow(settings, 'show-text', 'Afficher « Titre — Artiste »'));
        const lenRow = spinRow(settings, 'max-text-length', 'Longueur maximale du texte',
            'En caractères, tronqué avec « … »', 5, 200);
        settings.bind('show-text', lenRow, 'sensitive', Gio.SettingsBindFlags.GET);
        displayGroup.add(lenRow);
        displayGroup.add(switchRow(settings, 'show-mini-art', 'Mini-pochette dans l\'indicateur',
            'Remplace l\'icône quand la pochette est disponible'));
        displayGroup.add(switchRow(settings, 'hide-when-closed', 'Masquer quand Spotify est fermé',
            'Sinon, l\'indicateur reste visible en grisé'));

        // --- Interaction ------------------------------------------------------
        const inputGroup = new Adw.PreferencesGroup({title: 'Interaction'});
        page.add(inputGroup);
        inputGroup.add(switchRow(settings, 'middle-click-play-pause', 'Clic milieu = lecture/pause'));

        // --- Avancé -----------------------------------------------------------
        const advGroup = new Adw.PreferencesGroup({title: 'Avancé'});
        page.add(advGroup);
        advGroup.add(switchRow(settings, 'debug', 'Journaux de placement',
            'Visible avec : journalctl --user -f -o cat /usr/bin/gnome-shell'));

        // garder une référence tant que la fenêtre vit
        window._settings = settings;
    }
}
