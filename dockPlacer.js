// Placement du widget flottant à côté du dock (mode « dock-left » / « dock-right »).
//
// Détection du dock Ubuntu Dock / Dash to Dock :
//   docking.js crée, par moniteur, un acteur `DashToDock` (St.Bin) nommé
//   'dashtodockContainer', ajouté par Main.layoutManager.addChrome() donc
//   enfant direct de Main.layoutManager.uiGroup, avec une propriété
//   `monitorIndex`. La partie visible (le « pilule » du dock) est l'acteur de
//   classe CSS 'dash-background' (dash._background) ; à défaut on prend
//   'dashtodockBox' (le BoxLayout survolé), puis le conteneur lui-même.
//   On lit sa géométrie réelle via get_transformed_extents() (coordonnées
//   écran, translation d'animation comprise).
//   Recalcul sur notify::allocation / translation de cet acteur et de ses
//   ancêtres jusqu'au conteneur (le glissement du dock ne notifie que
//   l'ancêtre qui bouge), sur
//   monitors-changed / workareas-changed, et quand un enfant est ajouté/retiré
//   de uiGroup (le dock est recréé quand ses réglages ou les écrans changent).
// Fallback (dock introuvable) : centré en bas du moniteur principal, décalé de
//   `dock-offset` px vers la gauche/droite.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DOCK_CONTAINER_NAME = 'dashtodockContainer';
const FALLBACK_BOTTOM_MARGIN = 8;
const FALLBACK_HEIGHT = 44; // px logiques

function findDescendant(root, predicate, maxDepth = 8) {
    const queue = [[root, 0]];
    while (queue.length) {
        const [actor, depth] = queue.shift();
        if (predicate(actor))
            return actor;
        if (depth < maxDepth) {
            for (const child of actor.get_children())
                queue.push([child, depth + 1]);
        }
    }
    return null;
}

export class DockPlacer {
    /**
     * @param {import('./indicator.js').SpotifyIndicator} indicator
     * @param {Gio.Settings} settings
     * @param {'left'|'right'} side
     */
    constructor(indicator, settings, side) {
        this._indicator = indicator;
        this._settings = settings;
        this._side = side;
        this._dockActor = null;
        this._laterId = 0;
        this._lastLog = '';

        // Le layoutManager pilote la visibilité du wrapper (trackFullscreen) ;
        // l'indicateur pilote la visibilité de son propre container à
        // l'intérieur (Spotify fermé, vue d'ensemble). Pas de conflit.
        // indicator.container (St.Bin créé par PanelMenu.ButtonBox) doit remplir
        // le wrapper, dont on fixe la hauteur à celle du dock.
        indicator.container.set({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._wrapper = new St.Bin({
            name: 'spotifyDockControllerWrapper',
            style_class: 'sdc-floating-wrapper',
            child: indicator.container,
        });
        Main.layoutManager.addChrome(this._wrapper, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._wrapper.connectObject('notify::size', () => this._queueUpdate(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._queueUpdate(true), this);
        global.display.connectObject(
            'workareas-changed', () => this._queueUpdate(true), this);
        Main.layoutManager.uiGroup.connectObject(
            'child-added', (_g, child) => {
                if (child.name === DOCK_CONTAINER_NAME)
                    this._queueUpdate(true);
            },
            'child-removed', (_g, child) => {
                if (child === this._dockActor || child.name === DOCK_CONTAINER_NAME)
                    this._queueUpdate(true);
            }, this);
        Main.overview.connectObject(
            'showing', () => this._syncOverview(true),
            'hidden', () => this._syncOverview(false), this);
        this._settings.connectObject(
            'changed::dock-offset', () => this._queueUpdate(),
            'changed::hide-in-overview', () => this._syncOverview(Main.overview.visible), this);

        this._syncOverview(Main.overview.visible);
        this._queueUpdate(true);
    }

    _debug(msg) {
        if (this._settings.get_boolean('debug') && msg !== this._lastLog) {
            this._lastLog = msg;
            console.log(`[spotify-dock-controller] ${msg}`);
        }
    }

    _syncOverview(overviewVisible) {
        const hide = overviewVisible && this._settings.get_boolean('hide-in-overview');
        this._indicator.setOverviewHidden(hide);
    }

    _findDock() {
        const primary = Main.layoutManager.primaryIndex;
        const docks = Main.layoutManager.uiGroup.get_children()
            .filter(a => a.name === DOCK_CONTAINER_NAME);
        if (!docks.length)
            return null;
        const container = docks.find(d => d.monitorIndex === primary) ?? docks[0];
        const visible =
            (container.dash?._background instanceof St.Widget ? container.dash._background : null) ??
            findDescendant(container, a => a instanceof St.Widget && a.has_style_class_name('dash-background')) ??
            findDescendant(container, a => a.name === 'dashtodockBox') ??
            container;
        return {container, visible};
    }

    _trackDock(dock) {
        const actor = dock?.visible ?? null;
        if (actor === this._dockActor)
            return;
        for (const a of this._watched ?? [])
            a.disconnectObject(this);
        this._watched = [];
        this._dockActor = actor;
        if (!actor)
            return;
        // L'allocation d'un acteur est relative à son parent : quand le dock
        // glisse (DashSlideContainer) ou que le conteneur est déplacé, seul un
        // ancêtre notifie. On surveille donc toute la chaîne jusqu'au conteneur.
        for (let a = actor; a; a = a.get_parent()) {
            a.connectObject(
                'notify::allocation', () => this._queueUpdate(),
                'notify::translation-x', () => this._queueUpdate(),
                'notify::translation-y', () => this._queueUpdate(),
                'destroy', () => {
                    this._dockActor = null;
                    this._queueUpdate(true);
                }, this);
            this._watched.push(a);
            if (a === dock.container)
                break;
        }
    }

    _queueUpdate(rescan = false) {
        if (rescan)
            this._needRescan = true;
        if (this._laterId)
            return;
        const laters = global.compositor.get_laters();
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._update();
            return false;
        });
    }

    _update() {
        if (this._needRescan || !this._dockActor) {
            this._needRescan = false;
            this._trackDock(this._findDock());
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const offset = this._settings.get_int('dock-offset');
        const [, natW] = this._wrapper.get_preferred_width(-1);
        let x, y, h;

        const rect = this._dockActor?.mapped ? this._dockActor.get_transformed_extents() : null;
        // Dock vertical (gauche/droite) : « à côté » n'a pas de sens -> fallback
        if (rect && rect.size.width > 0 && rect.size.height > 0 &&
            rect.size.width >= rect.size.height) {
            const dx = rect.origin.x, dy = rect.origin.y;
            const dw = rect.size.width, dh = rect.size.height;
            h = Math.round(dh);
            y = Math.round(dy);
            x = this._side === 'left'
                ? Math.round(dx - offset - natW)
                : Math.round(dx + dw + offset);
            this._copyDockStyle();
            this._debug(`dock trouvé (${this._dockActor.name || this._dockActor.style_class}) ` +
                `x=${dx} y=${dy} w=${dw} h=${dh} -> widget x=${x} y=${y} h=${h}`);
        } else {
            // ButtonBox ignore min-height CSS : hauteur fixe raisonnable
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            h = FALLBACK_HEIGHT * scale;
            y = monitor.y + monitor.height - h - FALLBACK_BOTTOM_MARGIN;
            const center = monitor.x + monitor.width / 2;
            x = this._side === 'left'
                ? Math.round(center - offset - natW)
                : Math.round(center + offset);
            this._debug(`dock introuvable -> fallback centre-bas x=${x} y=${y}`);
        }

        // Rester dans le moniteur
        x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - natW));
        y = Math.max(monitor.y, Math.min(y, monitor.y + monitor.height - h));

        this._wrapper.set_position(x, y);
        this._wrapper.set_height(h);
    }

    /** Reprend couleur de fond et arrondi du dock pour une intégration visuelle. */
    _copyDockStyle() {
        const bg = this._dockActor;
        if (!(bg instanceof St.Widget) || !bg.has_style_class_name('dash-background'))
            return;
        try {
            const node = bg.get_theme_node();
            const c = node.get_background_color();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const radius = Math.round(node.get_border_radius(St.Corner.TOPLEFT) / scale);
            const style = c.alpha > 0
                ? `background-color: rgba(${c.red}, ${c.green}, ${c.blue}, ${(c.alpha / 255).toFixed(3)}); border-radius: ${radius}px;`
                : `border-radius: ${radius}px;`;
            if (this._indicator.style !== style)
                this._indicator.style = style;
        } catch {
            // thème inattendu : on garde le style CSS par défaut
        }
    }

    destroy() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        for (const a of this._watched ?? [])
            a.disconnectObject(this);
        this._watched = [];
        this._dockActor = null;
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._wrapper.disconnectObject(this);
        // On rend indicator.container (l'extension détruit l'indicateur juste
        // après), puis on détruit le wrapper : le layoutManager le dé-traque
        // automatiquement sur 'destroy'.
        this._wrapper.child = null;
        this._wrapper.destroy();
        this._wrapper = null;
        this._indicator = null;
    }
}
