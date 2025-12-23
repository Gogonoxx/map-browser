/**
 * Cze & Peku Map Browser
 * Browse and create Scenes from OneDrive-hosted maps
 *
 * Features:
 * - 2-level UI: Location Grid → Flavor Panel
 * - Smart search with auto-generated tags
 * - One-click Scene creation
 * - Support for animated maps (MP4, WebM)
 */

const MODULE_ID = 'map-browser';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// ============================================================================
// Map Browser Application
// ============================================================================

class MapBrowserApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static get instance() { return this.#instance; }

  static DEFAULT_OPTIONS = {
    id: 'map-browser',
    classes: ['map-browser'],
    window: {
      title: 'MAP_BROWSER.Title',
      icon: 'fas fa-map',
      resizable: true
    },
    position: { width: 1000, height: 750 }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/browser.hbs` }
  };

  // State
  #manifest = null;
  #searchQuery = '';
  #expandedLocation = null;
  #loading = true;

  constructor(options = {}) {
    super(options);
    MapBrowserApp.#instance = this;
  }

  // -------------------------------------------------------------------------
  // Data Preparation
  // -------------------------------------------------------------------------

  async _prepareContext(options) {
    // Load manifest if not already loaded
    if (!this.#manifest) {
      await this.#loadManifest();
    }

    // Filter locations based on search
    let locations = this.#manifest?.locations || [];

    if (this.#searchQuery) {
      const query = this.#searchQuery.toLowerCase();
      const queryTerms = query.split(/\s+/).filter(t => t.length > 0);

      locations = locations.filter(loc => {
        // Check location name
        const locationMatch = loc.title.toLowerCase().includes(query) ||
                              loc.folder_name.toLowerCase().includes(query);
        if (locationMatch) return true;

        // Check smart tags
        const tagMatch = loc.smart_tags.some(tag => queryTerms.some(term => tag.includes(term)));
        if (tagMatch) return true;

        // Check flavor names and their tags
        const flavorMatch = loc.flavors.some(f =>
          f.display_name.toLowerCase().includes(query) ||
          f.smart_tags.some(tag => queryTerms.some(term => tag.includes(term)))
        );
        if (flavorMatch) return true;

        // Check searchable text
        return loc.searchable_text?.toLowerCase().includes(query);
      });
    }

    // Prepare locations for display
    const displayLocations = locations.map(loc => ({
      ...loc,
      expanded: loc.id === this.#expandedLocation,
      thumbnail: this.#getThumbnailUrl(loc),
      tagBadges: loc.smart_tags.slice(0, 4) // Limit displayed tags
    }));

    return {
      locations: displayLocations,
      totalLocations: this.#manifest?.total_locations || 0,
      totalFlavors: this.#manifest?.total_flavors || 0,
      totalFiles: this.#manifest?.total_files || 0,
      searchQuery: this.#searchQuery,
      loading: this.#loading,
      hasOneDriveUrl: !!this.#manifest?.onedrive_api_base,
      resultCount: displayLocations.length
    };
  }

  async #loadManifest() {
    this.#loading = true;
    try {
      const response = await fetch(`modules/${MODULE_ID}/data/map-manifest.json`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.#manifest = await response.json();
      console.log(`${MODULE_ID} | Loaded manifest: ${this.#manifest.total_locations} locations`);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to load manifest:`, err);
      ui.notifications.error('Failed to load map manifest. Check console for details.');
      this.#manifest = { locations: [], total_locations: 0, total_flavors: 0, total_files: 0 };
    }
    this.#loading = false;
  }

  #getThumbnailUrl(location) {
    // Use bundled placeholder - we'll generate actual thumbs later
    return `modules/${MODULE_ID}/data/thumbs/${location.id}.webp`;
  }

  // -------------------------------------------------------------------------
  // Scene Creation
  // -------------------------------------------------------------------------

  async #createScene(location, flavor, file) {
    if (!this.#manifest?.onedrive_api_base) {
      ui.notifications.error(game.i18n.localize('MAP_BROWSER.ConfigureOneDrive'));
      return;
    }

    // Build the file path (files can be in Maps subfolder or directly in root)
    const filePath = location.files_in_root
      ? `${location.folder_name}/${file.filename}`
      : `${location.folder_name}/Maps/${file.filename}`;

    // Encode path components (but not slashes)
    const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');

    // Build full OneDrive URL
    const imageUrl = `${this.#manifest.onedrive_api_base}/${encodedPath}:/content`;

    // Build scene name
    let sceneName = location.title;
    if (flavor.name !== 'Original') {
      sceneName += ` - ${flavor.display_name}`;
    }
    if (file.sub_variant) {
      sceneName += ` (${file.sub_variant})`;
    }

    // Create Scene with sensible defaults
    const sceneData = {
      name: sceneName,
      background: {
        src: imageUrl
      },
      grid: {
        type: 1,           // Square grid
        size: 100,         // 100px per grid square
        distance: 5,       // 5 feet per square (PF2E standard)
        units: 'ft'
      },
      padding: 0.1,        // 10% padding
      tokenVision: false,  // Disable for quick setup
      flags: {
        [MODULE_ID]: {
          source: 'czepeku',
          locationId: location.id,
          flavorName: flavor.name,
          filename: file.filename
        }
      }
    };

    try {
      const scene = await Scene.create(sceneData);
      ui.notifications.info(`${game.i18n.localize('MAP_BROWSER.SceneCreated')}: ${sceneName}`);

      // Ask to activate
      const activate = await Dialog.confirm({
        title: game.i18n.localize('MAP_BROWSER.SceneCreated'),
        content: `<p>${game.i18n.localize('MAP_BROWSER.ActivateScene')}</p>`,
        yes: () => true,
        no: () => false
      });

      if (activate) {
        await scene.activate();
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to create scene:`, err);
      ui.notifications.error(`Failed to create scene: ${err.message}`);
    }
  }

  #previewImage(location, flavor, file) {
    if (!this.#manifest?.onedrive_api_base) {
      ui.notifications.error(game.i18n.localize('MAP_BROWSER.ConfigureOneDrive'));
      return;
    }

    const filePath = location.files_in_root
      ? `${location.folder_name}/${file.filename}`
      : `${location.folder_name}/Maps/${file.filename}`;
    const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
    const imageUrl = `${this.#manifest.onedrive_api_base}/${encodedPath}:/content`;

    window.open(imageUrl, '_blank');
  }

  // -------------------------------------------------------------------------
  // Event Handling
  // -------------------------------------------------------------------------

  _onRender(context, options) {
    const html = this.element;

    // Search input with debounce
    const searchInput = html.querySelector('[name="search"]');
    let searchTimeout;
    searchInput?.addEventListener('input', (ev) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.#searchQuery = ev.target.value;
        this.render();
      }, 300);
    });

    // Keep focus on search input
    searchInput?.focus();

    // Location card click → expand/collapse
    html.querySelectorAll('[data-action="toggle-location"]').forEach(el => {
      el.addEventListener('click', (ev) => {
        const locationId = ev.currentTarget.dataset.locationId;
        this.#expandedLocation = this.#expandedLocation === locationId ? null : locationId;
        this.render();
      });
    });

    // Create scene button
    html.querySelectorAll('[data-action="create-scene"]').forEach(el => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const { locationId, flavorIndex, fileIndex } = ev.currentTarget.dataset;

        const location = this.#manifest.locations.find(l => l.id === locationId);
        const flavor = location?.flavors[parseInt(flavorIndex)];
        const file = flavor?.files[parseInt(fileIndex)];

        if (location && flavor && file) {
          await this.#createScene(location, flavor, file);
        }
      });
    });

    // Preview button
    html.querySelectorAll('[data-action="preview"]').forEach(el => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const { locationId, flavorIndex, fileIndex } = ev.currentTarget.dataset;

        const location = this.#manifest.locations.find(l => l.id === locationId);
        const flavor = location?.flavors[parseInt(flavorIndex)];
        const file = flavor?.files[parseInt(fileIndex)];

        if (location && flavor && file) {
          this.#previewImage(location, flavor, file);
        }
      });
    });

    // Handle thumbnail errors - show placeholder
    html.querySelectorAll('.location-thumbnail').forEach(img => {
      img.addEventListener('error', () => {
        img.src = 'icons/svg/mystery-man.svg';
      });
    });
  }
}

// ============================================================================
// Module Initialization
// ============================================================================

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing Cze & Peku Map Browser`);
});

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | Ready`);

  // Expose global API
  globalThis.MapBrowser = {
    open: () => {
      if (MapBrowserApp.instance?.rendered) {
        MapBrowserApp.instance.bringToFront();
      } else {
        new MapBrowserApp().render(true);
      }
    }
  };
});

// Add scene control button
Hooks.on('getSceneControlButtons', (controls) => {
  // Find the token controls group
  const tokenControls = controls.find(c => c.name === 'token');
  if (!tokenControls || !game.user.isGM) return;

  // Add our button
  tokenControls.tools.push({
    name: 'map-browser',
    title: 'Cze & Peku Map Browser',
    icon: 'fas fa-map',
    button: true,
    onClick: () => {
      MapBrowser.open();
    }
  });
});
