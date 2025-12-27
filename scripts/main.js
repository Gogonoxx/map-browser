/**
 * Map Browser
 * Browse and create Scenes from OneDrive-hosted maps
 *
 * Features:
 * - 2-level UI: Location Grid → Flavor Panel
 * - Smart search with auto-generated tags
 * - One-click Scene creation
 * - Support for animated maps (MP4, WebM)
 * - Support for Czepeku and Beneos map collections
 * - Beneos maps: Separate Scenery/Battlemap buttons
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
  #variantMapping = null;
  #searchQuery = '';
  #expandedLocation = null;
  #loading = true;
  #cursorPosition = undefined;
  #scrollPosition = 0;
  #shouldScrollToExpanded = false;
  #showAnimatedOnly = false;

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

    // Filter locations based on search and animated toggle
    let locations = this.#manifest?.locations || [];

    // Filter by animated if toggle is on
    if (this.#showAnimatedOnly) {
      locations = locations.filter(loc => loc.has_animated);
    }

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
    const displayLocations = locations.map(loc => {
      const isExpanded = loc.id === this.#expandedLocation;

      // Add variant thumbnails to files if expanded
      let flavors = loc.flavors;
      if (isExpanded && this.#variantMapping) {
        flavors = loc.flavors.map(flavor => ({
          ...flavor,
          files: flavor.files?.map(file => ({
            ...file,
            variantThumb: this.#getVariantThumbUrl(loc.id, flavor.name, file.filename)
          })),
          // Beneos maps: add thumbnails to scenery/battlemap files
          scenery_files: flavor.scenery_files?.map(file => ({
            ...file,
            variantThumb: this.#getVariantThumbUrl(loc.id, flavor.name, file.filename)
          })),
          battlemap_files: flavor.battlemap_files?.map(file => ({
            ...file,
            variantThumb: this.#getVariantThumbUrl(loc.id, flavor.name, file.filename)
          }))
        }));
      }

      return {
        ...loc,
        flavors,
        expanded: isExpanded,
        thumbnail: this.#getThumbnailUrl(loc),
        tagBadges: loc.smart_tags.slice(0, 4) // Limit displayed tags
      };
    });

    return {
      locations: displayLocations,
      totalLocations: this.#manifest?.total_locations || 0,
      totalFlavors: this.#manifest?.total_flavors || 0,
      totalFiles: this.#manifest?.total_files || 0,
      searchQuery: this.#searchQuery,
      loading: this.#loading,
      hasOneDriveUrl: !!(this.#manifest?.worker_base_url || this.#manifest?.onedrive_api_base),
      resultCount: displayLocations.length,
      showAnimatedOnly: this.#showAnimatedOnly,
      animatedCount: this.#manifest?.locations?.filter(l => l.has_animated).length || 0
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

      // Load variant thumbnail mapping
      try {
        const mappingResponse = await fetch(`modules/${MODULE_ID}/data/variant-thumbs/_mapping.json`);
        if (mappingResponse.ok) {
          this.#variantMapping = await mappingResponse.json();
          console.log(`${MODULE_ID} | Loaded variant mapping: ${Object.keys(this.#variantMapping).length} entries`);
        }
      } catch (e) {
        console.log(`${MODULE_ID} | No variant mapping found`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to load manifest:`, err);
      ui.notifications.error('Failed to load map manifest. Check console for details.');
      this.#manifest = { locations: [], total_locations: 0, total_flavors: 0, total_files: 0 };
    }
    this.#loading = false;
  }

  #getThumbnailUrl(location) {
    // Use local thumbnail from module folder (fast loading)
    if (location.thumbnail) {
      return `modules/${MODULE_ID}/data/thumbs/${location.folder_name}.jpg`;
    }
    // Fallback to placeholder
    return 'icons/svg/mystery-man.svg';
  }

  #getVariantThumbUrl(locationId, flavorName, filename) {
    if (!this.#variantMapping) return null;
    const key = `${locationId}|${flavorName}|${filename}`;
    const variantId = this.#variantMapping[key];
    if (variantId) {
      return `modules/${MODULE_ID}/data/variant-thumbs/${variantId}.webp`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Scene Creation
  // -------------------------------------------------------------------------

  async #createScene(location, flavor, file) {
    // Check for either Worker URL or legacy OneDrive API base
    if (!this.#manifest?.worker_base_url && !this.#manifest?.onedrive_api_base) {
      ui.notifications.error(game.i18n.localize('MAP_BROWSER.ConfigureOneDrive'));
      return;
    }

    // Build the file path (files can be in Maps subfolder or directly in root)
    const filePath = location.files_in_root
      ? `${location.folder_name}/${file.filename}`
      : `${location.folder_name}/Maps/${file.filename}`;

    // Encode path components (but not slashes)
    const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');

    // Build image URL - prefer Worker URL (recommended) over legacy OneDrive API
    let imageUrl;
    if (this.#manifest.worker_base_url) {
      // Cloudflare Worker URL - simple format, handles auth internally
      imageUrl = `${this.#manifest.worker_base_url}/${encodedPath}`;
    } else {
      // Legacy OneDrive API URL (may not work with new share format)
      imageUrl = `${this.#manifest.onedrive_api_base}/${encodedPath}:/content#${file.filename}`;
    }

    // Build scene name
    let sceneName = location.title;
    if (flavor.name !== 'Original') {
      sceneName += ` - ${flavor.display_name}`;
    }
    if (file.sub_variant) {
      sceneName += ` (${file.sub_variant})`;
    }

    // Check if file is animated (video)
    const isVideo = file.animated || false;

    // Load media to get actual dimensions (preserves aspect ratio)
    const loadingMsg = isVideo ? 'Loading video dimensions...' : 'Loading image dimensions...';
    ui.notifications.info(game.i18n.localize('MAP_BROWSER.LoadingImage') || loadingMsg);
    let imgWidth = 4096;  // Default fallback
    let imgHeight = 4096;

    try {
      const dimensions = await this.#loadMediaDimensions(imageUrl, isVideo);
      imgWidth = dimensions.width;
      imgHeight = dimensions.height;
      console.log(`${MODULE_ID} | Media dimensions: ${imgWidth}x${imgHeight} (video: ${isVideo})`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not load media dimensions, using defaults:`, err);
      ui.notifications.warn('Could not determine media size, using defaults.');
    }

    // Create Scene with actual image dimensions
    const sceneData = {
      name: sceneName,
      width: imgWidth,
      height: imgHeight,
      backgroundColor: '#000000',
      background: {
        src: imageUrl
      },
      grid: {
        type: 1,           // Square grid
        size: 100,         // 100px per grid square
        distance: 5,       // 5 feet per square (PF2E standard)
        units: 'ft'
      },
      padding: 0,          // No padding - show image as-is
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
      console.log(`${MODULE_ID} | Creating scene:`, sceneData);
      const scene = await Scene.create(sceneData);

      if (!scene) {
        throw new Error('Scene.create() returned undefined - check Foundry permissions');
      }

      ui.notifications.info(`${game.i18n.localize('MAP_BROWSER.SceneCreated')}: ${sceneName}`);

      // Ask to activate
      const activate = await Dialog.confirm({
        title: game.i18n.localize('MAP_BROWSER.SceneCreated'),
        content: `<p>${game.i18n.localize('MAP_BROWSER.ActivateScene')}</p>`,
        yes: () => true,
        no: () => false
      });

      if (activate && scene.activate) {
        await scene.activate();
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to create scene:`, err);
      console.error(`${MODULE_ID} | Scene data was:`, sceneData);
      ui.notifications.error(`Failed to create scene: ${err.message}`);
    }
  }

  /**
   * Create a Scene from a Beneos map (Scenery or Battlemap)
   * @param {Object} location - The location data
   * @param {Object} flavor - The flavor (subfolder) data
   * @param {string} fileType - 'scenery' or 'battlemap'
   */
  async #createBeneosScene(location, flavor, fileType) {
    if (!this.#manifest?.worker_base_url && !this.#manifest?.onedrive_api_base) {
      ui.notifications.error(game.i18n.localize('MAP_BROWSER.ConfigureOneDrive'));
      return;
    }

    // Get the appropriate file list
    const files = fileType === 'scenery' ? flavor.scenery_files : flavor.battlemap_files;
    if (!files || files.length === 0) {
      ui.notifications.warn(`No ${fileType} files found for this scene.`);
      return;
    }

    // Prefer animated version, fall back to static
    let file = files.find(f => f.animated) || files[0];
    const isVideo = file.animated;

    // Build the file path: Beneos/{location}/{subfolder}/{filename}
    const filePath = `${location.beneos_path}/${flavor.name}/${file.filename}`;

    // Encode path components (but not slashes)
    const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');

    // Build media URL
    let mediaUrl;
    if (this.#manifest.worker_base_url) {
      mediaUrl = `${this.#manifest.worker_base_url}/${encodedPath}`;
    } else {
      mediaUrl = `${this.#manifest.onedrive_api_base}/${encodedPath}:/content#${file.filename}`;
    }

    // Build scene name
    let sceneName = `${location.title} - ${flavor.display_name}`;
    if (fileType === 'scenery') {
      sceneName += ' (Scenery)';
    }

    // Load media to get dimensions
    const loadingMsg = isVideo ? 'Loading video dimensions...' : 'Loading image dimensions...';
    ui.notifications.info(game.i18n.localize('MAP_BROWSER.LoadingImage') || loadingMsg);
    let mediaWidth = 3840;  // 4K default
    let mediaHeight = 2160;

    try {
      const dimensions = await this.#loadMediaDimensions(mediaUrl, isVideo);
      mediaWidth = dimensions.width;
      mediaHeight = dimensions.height;
      console.log(`${MODULE_ID} | Media dimensions: ${mediaWidth}x${mediaHeight} (video: ${isVideo})`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not load media dimensions, using defaults:`, err);
      ui.notifications.warn('Could not determine media size, using 4K defaults.');
    }

    // Create Scene
    const sceneData = {
      name: sceneName,
      width: mediaWidth,
      height: mediaHeight,
      backgroundColor: '#000000',
      background: {
        src: mediaUrl
      },
      grid: {
        type: fileType === 'battlemap' ? 1 : 0,  // Grid for battlemap, none for scenery
        size: 100,
        distance: 5,
        units: 'ft'
      },
      padding: 0,
      tokenVision: false,
      flags: {
        [MODULE_ID]: {
          source: 'beneos',
          locationId: location.id,
          flavorName: flavor.name,
          filename: file.filename,
          fileType: fileType
        }
      }
    };

    try {
      console.log(`${MODULE_ID} | Creating Beneos scene:`, sceneData);
      const scene = await Scene.create(sceneData);

      if (!scene) {
        throw new Error('Scene.create() returned undefined - check Foundry permissions');
      }

      ui.notifications.info(`${game.i18n.localize('MAP_BROWSER.SceneCreated')}: ${sceneName}`);

      // Ask to activate
      const activate = await Dialog.confirm({
        title: game.i18n.localize('MAP_BROWSER.SceneCreated'),
        content: `<p>${game.i18n.localize('MAP_BROWSER.ActivateScene')}</p>`,
        yes: () => true,
        no: () => false
      });

      if (activate && scene.activate) {
        await scene.activate();
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to create Beneos scene:`, err);
      console.error(`${MODULE_ID} | Scene data was:`, sceneData);
      ui.notifications.error(`Failed to create scene: ${err.message}`);
    }
  }

  /**
   * Load an image to get its dimensions
   * @param {string} url - The image URL
   * @returns {Promise<{width: number, height: number}>}
   */
  async #loadImageDimensions(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const timeout = setTimeout(() => {
        reject(new Error('Image load timeout'));
      }, 30000); // 30 second timeout

      img.onload = () => {
        clearTimeout(timeout);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };

      img.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  }

  /**
   * Load a video to get its dimensions
   * @param {string} url - The video URL
   * @returns {Promise<{width: number, height: number}>}
   */
  async #loadVideoDimensions(url) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.preload = 'metadata';

      const timeout = setTimeout(() => {
        video.src = '';
        reject(new Error('Video metadata load timeout'));
      }, 30000); // 30 second timeout

      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve({ width: video.videoWidth, height: video.videoHeight });
        video.src = ''; // Clean up
      };

      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load video metadata'));
      };

      video.src = url;
    });
  }

  /**
   * Load media dimensions (image or video)
   * @param {string} url - The media URL
   * @param {boolean} isVideo - Whether the media is a video
   * @returns {Promise<{width: number, height: number}>}
   */
  async #loadMediaDimensions(url, isVideo = false) {
    if (isVideo) {
      return this.#loadVideoDimensions(url);
    }
    return this.#loadImageDimensions(url);
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
      const cursorPos = ev.target.selectionStart;
      searchTimeout = setTimeout(() => {
        this.#searchQuery = ev.target.value;
        this.#cursorPosition = cursorPos;
        this.render();
      }, 500); // Longer debounce for smoother typing
    });

    // Restore cursor position after render
    if (searchInput && this.#cursorPosition !== undefined) {
      searchInput.focus();
      searchInput.setSelectionRange(this.#cursorPosition, this.#cursorPosition);
    } else if (searchInput && !this.#searchQuery) {
      searchInput.focus();
    }

    // Animated toggle
    const animatedToggle = html.querySelector('[data-action="toggle-animated"]');
    animatedToggle?.addEventListener('click', () => {
      this.#showAnimatedOnly = !this.#showAnimatedOnly;
      this.render();
    });

    // Location card click → expand/collapse
    html.querySelectorAll('[data-action="toggle-location"]').forEach(el => {
      el.addEventListener('click', (ev) => {
        const locationId = ev.currentTarget.dataset.locationId;
        const grid = html.querySelector('.locations-grid');

        // Save scroll position
        this.#scrollPosition = grid?.scrollTop || 0;

        // Toggle expansion
        const wasExpanded = this.#expandedLocation === locationId;
        this.#expandedLocation = wasExpanded ? null : locationId;

        // Mark that we should scroll to the expanded card
        this.#shouldScrollToExpanded = !wasExpanded;

        this.render();
      });
    });

    // Create scene button (Czepeku)
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

    // Create Beneos scene button (Scenery/Battlemap)
    const beneosButtons = html.querySelectorAll('[data-action="create-beneos-scene"]');
    console.log(`${MODULE_ID} | Found ${beneosButtons.length} Beneos scene buttons`);

    beneosButtons.forEach(el => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const { locationId, flavorIndex, fileType } = ev.currentTarget.dataset;
        console.log(`${MODULE_ID} | Beneos button clicked:`, { locationId, flavorIndex, fileType });

        const location = this.#manifest.locations.find(l => l.id === locationId);
        const flavor = location?.flavors[parseInt(flavorIndex)];
        console.log(`${MODULE_ID} | Found location:`, location?.title, 'flavor:', flavor?.display_name);

        if (location && flavor) {
          await this.#createBeneosScene(location, flavor, fileType);
        } else {
          console.error(`${MODULE_ID} | Could not find location or flavor!`, { location, flavor });
        }
      });
    });

    // Handle thumbnail errors - show placeholder
    html.querySelectorAll('.location-thumbnail').forEach(img => {
      img.addEventListener('error', () => {
        img.src = 'icons/svg/mystery-man.svg';
      });
    });

    // Hover-to-enlarge for thumbnails - creates overlay on hover (with 500ms delay)
    let previewOverlay = null;
    let previewTimeout = null;

    const showPreview = (img) => {
      if (previewOverlay) return;

      previewOverlay = document.createElement('img');
      previewOverlay.className = 'thumbnail-preview-overlay';
      previewOverlay.src = img.src;
      document.body.appendChild(previewOverlay);
    };

    const hidePreview = () => {
      // Cancel pending preview
      if (previewTimeout) {
        clearTimeout(previewTimeout);
        previewTimeout = null;
      }
      // Remove existing preview
      if (previewOverlay) {
        previewOverlay.remove();
        previewOverlay = null;
      }
    };

    const schedulePreview = (img) => {
      hidePreview(); // Clear any existing
      previewTimeout = setTimeout(() => showPreview(img), 500);
    };

    // Add hover handlers for location thumbnails
    html.querySelectorAll('.location-thumbnail').forEach(img => {
      img.addEventListener('mouseenter', () => schedulePreview(img));
      img.addEventListener('mouseleave', hidePreview);
    });

    // Add hover handlers for variant thumbnails
    html.querySelectorAll('.variant-thumbnail').forEach(img => {
      img.addEventListener('mouseenter', () => schedulePreview(img));
      img.addEventListener('mouseleave', hidePreview);
    });

    // Restore scroll position or scroll to expanded card
    const grid = html.querySelector('.locations-grid');
    if (grid) {
      if (this.#shouldScrollToExpanded && this.#expandedLocation) {
        // Find the expanded card and scroll to it
        const expandedCard = html.querySelector(`.location-card.expanded`);
        if (expandedCard) {
          // Use setTimeout to ensure DOM is fully rendered
          setTimeout(() => {
            expandedCard.scrollIntoView({ behavior: 'instant', block: 'start' });
            // Add a small offset so the card isn't at the very top
            grid.scrollTop = Math.max(0, grid.scrollTop - 10);
          }, 10);
        }
        this.#shouldScrollToExpanded = false;
      } else if (this.#scrollPosition > 0) {
        // Restore previous scroll position
        grid.scrollTop = this.#scrollPosition;
      }
    }
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
    },

    /**
     * Create a scene directly from a location ID
     * @param {string} locationId - The location ID (e.g., "beneos-ashur-fire-temple")
     * @returns {Promise<Scene|null>} The created scene or null on failure
     */
    createSceneFromLocation: async (locationId) => {
      try {
        // Load manifest
        const manifestResponse = await fetch(`modules/${MODULE_ID}/data/map-manifest.json`);
        if (!manifestResponse.ok) {
          ui.notifications.error('Could not load map manifest');
          return null;
        }
        const manifest = await manifestResponse.json();

        // Find location
        const location = manifest.locations.find(loc => loc.id === locationId);
        if (!location) {
          ui.notifications.error(`Location not found: ${locationId}`);
          return null;
        }

        // Get first flavor with files
        const flavor = location.flavors?.[0];
        if (!flavor) {
          ui.notifications.error(`No map variants found for: ${location.title}`);
          return null;
        }

        // Determine if this is a Beneos map (has scenery/battlemap files)
        const isBeneos = flavor.scenery_files || flavor.battlemap_files;

        let file, filePath, isVideo;

        if (isBeneos) {
          // Beneos map - prefer battlemap, then scenery
          const files = flavor.battlemap_files || flavor.scenery_files || [];
          file = files.find(f => f.animated) || files[0];
          if (!file) {
            ui.notifications.error(`No files found for: ${location.title}`);
            return null;
          }
          filePath = `${location.beneos_path}/${flavor.name}/${file.filename}`;
          isVideo = file.animated;
        } else {
          // Cze & Peku map - use flavor files
          const files = flavor.files || [];
          file = files.find(f => f.animated) || files.find(f => !f.animated) || files[0];
          if (!file) {
            ui.notifications.error(`No files found for: ${location.title}`);
            return null;
          }
          filePath = location.files_in_root
            ? `${location.folder_name}/${file.filename}`
            : `${location.folder_name}/Maps/${file.filename}`;
          isVideo = file.animated;
        }

        // Build URL
        const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
        const mediaUrl = manifest.worker_base_url
          ? `${manifest.worker_base_url}/${encodedPath}`
          : `${manifest.onedrive_api_base}/${encodedPath}:/content#${file.filename}`;

        // Build scene name
        let sceneName = location.title;
        if (flavor.name !== 'Original' && flavor.display_name) {
          sceneName += ` - ${flavor.display_name}`;
        }

        ui.notifications.info(`Creating scene: ${sceneName}...`);

        // Create scene with default dimensions (will be updated by Foundry)
        const sceneData = {
          name: sceneName,
          width: 4096,
          height: 4096,
          backgroundColor: '#000000',
          background: { src: mediaUrl },
          grid: { type: 1, size: 100, distance: 5, units: 'ft' },
          padding: 0,
          tokenVision: false,
          flags: {
            [MODULE_ID]: {
              source: isBeneos ? 'beneos' : 'czepeku',
              locationId: location.id,
              flavorName: flavor.name,
              filename: file.filename
            }
          }
        };

        const scene = await Scene.create(sceneData);
        if (!scene) {
          throw new Error('Scene.create() failed');
        }

        ui.notifications.info(`Scene created: ${sceneName}`);

        // Ask to activate
        const activate = await Dialog.confirm({
          title: 'Scene Created',
          content: `<p>Activate scene "${sceneName}"?</p>`,
          yes: () => true,
          no: () => false
        });

        if (activate) {
          await scene.activate();
        }

        return scene;
      } catch (err) {
        console.error(`${MODULE_ID} | createSceneFromLocation failed:`, err);
        ui.notifications.error(`Failed to create scene: ${err.message}`);
        return null;
      }
    }
  };
});

// Add scene control button (V13 API: controls is Record<string, SceneControl>)
Hooks.on('getSceneControlButtons', (controls) => {
  const tokenControls = controls.tokens;
  if (tokenControls?.tools) {
    tokenControls.tools['map-browser'] = {
      name: 'map-browser',
      title: 'Cze & Peku Map Browser',
      icon: 'fas fa-map',
      button: true,
      visible: game.user.isGM,
      onClick: () => {
        MapBrowser.open();
      }
    };
  }
});
