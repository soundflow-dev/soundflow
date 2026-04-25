/**
 * SoundFlow Card — Music Assistant powered Lovelace card
 * Version: 2.0.0
 *
 * Entity detection (based on real MA installation):
 *  - Speakers : media_player.* with attributes.mass_player_type === "player"
 *  - Groups   : media_player.* with attributes.mass_player_type === "group"
 *  - Source   : source_list of active speaker (e.g. "Apple Music", "Music Assistant Queue")
 *
 * No "platform" attribute filter — MA entities don't always set platform attribute.
 */

const SF_VERSION = "2.0.0";

class SoundFlowCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._searchFocused = false;
    this._progressTimer = null;
    this._progressPosition = 0;
    this._progressDuration = 0;
    this._state = {
      showFullCard: false,
      showSourcePopup: false,
      showSpeakersPopup: false,
      showQueuePopup: false,
      showSettingsPopup: false,
      activeSpeaker: null,
      activeSpeakers: [],
      selectedGroupId: null,
      allSpeakers: [],
      allGroups: [],
      visibleSpeakers: [],
      sourceList: [],
      searchQuery: "",
      searchResults: { library: [], catalog: [] },
      searching: false,
      isMuted: false,
      queue: [],
      loadingQueue: false,
    };
  }

  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = config;
    try { this._state.selectedGroupId = localStorage.getItem("soundflow_speaker_group") || null; } catch (_) {}
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateState();
    if (this._searchFocused) return;
    this.render();
  }

  disconnectedCallback() { this._stopProgressTimer(); }

  // ─── State ────────────────────────────────────────────────────────────────

  _updateState() {
    if (!this._hass) return;
    const states = this._hass.states;

    const configured = this._config?.speakers || [];
    let allSpeakers;

    if (configured.length > 0) {
      allSpeakers = configured
        .map(id => { const s = states[id]; if (!s) return null; return this._mapSpeaker(id, s); })
        .filter(Boolean);
    } else {
      allSpeakers = Object.entries(states)
        .filter(([id, s]) => id.startsWith("media_player.") && s.attributes.mass_player_type === "player")
        .map(([id, s]) => this._mapSpeaker(id, s));
    }

    // Deduplicate: prefer entity without _2 suffix
    const seen = new Map();
    allSpeakers.forEach(sp => {
      const base = sp.entityId.replace(/_2$/, "");
      if (!seen.has(base) || !sp.entityId.endsWith("_2")) seen.set(base, sp);
    });
    this._state.allSpeakers = [...seen.values()];

    // Groups
    this._state.allGroups = Object.entries(states)
      .filter(([id, s]) => id.startsWith("media_player.") && s.attributes.mass_player_type === "group")
      .map(([id, s]) => ({
        entityId: id,
        name: s.attributes.friendly_name || id,
        members: s.attributes.group_members || [],
        state: s.state,
        volume: Math.round((s.attributes.volume_level || 0) * 100),
        isMuted: s.attributes.is_volume_muted || false,
        title: s.attributes.media_title || null,
        artist: s.attributes.media_artist || null,
        artwork: s.attributes.entity_picture || null,
        shuffle: s.attributes.shuffle || false,
        repeat: s.attributes.repeat || "off",
        mediaPosition: s.attributes.media_position || 0,
        mediaDuration: s.attributes.media_duration || 0,
        mediaPositionUpdatedAt: s.attributes.media_position_updated_at || null,
        mediaContentType: s.attributes.media_content_type || "",
        mediaContentId: s.attributes.media_content_id || null,
        sourceList: s.attributes.source_list || [],
        source: s.attributes.source || null,
      }));

    // Visible speakers filtered by selected group
    let visibleSpeakers = this._state.allSpeakers;
    if (this._state.selectedGroupId) {
      const grp = this._state.allGroups.find(g => g.entityId === this._state.selectedGroupId);
      if (grp?.members?.length > 0) {
        const filtered = this._state.allSpeakers.filter(sp =>
          grp.members.some(m => m === sp.entityId || m.replace(/_2$/, "") === sp.entityId.replace(/_2$/, ""))
        );
        if (filtered.length > 0) visibleSpeakers = filtered;
      }
    }
    this._state.visibleSpeakers = visibleSpeakers;

    // Active speaker
    const playing = visibleSpeakers.find(s => s.state === "playing");
    const paused  = visibleSpeakers.find(s => s.state === "paused");
    if (!this._state.activeSpeaker) {
      this._state.activeSpeaker = playing || paused || visibleSpeakers[0] || null;
    } else {
      const updated = this._state.allSpeakers.find(s => s.entityId === this._state.activeSpeaker.entityId);
      if (updated) this._state.activeSpeaker = updated;
      else this._state.activeSpeaker = playing || paused || visibleSpeakers[0] || null;
    }

    if (this._state.activeSpeaker) {
      const raw = states[this._state.activeSpeaker.entityId];
      this._state.sourceList = raw?.attributes?.source_list || [];
      this._state.isMuted    = raw?.attributes?.is_volume_muted || false;
    }

    if (this._state.activeSpeakers.length === 0 && this._state.activeSpeaker)
      this._state.activeSpeakers = [this._state.activeSpeaker.entityId];

    this._syncProgress();
  }

  _mapSpeaker(id, s) {
    return {
      entityId: id,
      name: s.attributes.friendly_name || id,
      volume: Math.round((s.attributes.volume_level || 0) * 100),
      state: s.state,
      isMuted: s.attributes.is_volume_muted || false,
      title: s.attributes.media_title || null,
      artist: s.attributes.media_artist || null,
      album: s.attributes.media_album_name || null,
      artwork: s.attributes.entity_picture || null,
      shuffle: s.attributes.shuffle || false,
      repeat: s.attributes.repeat || "off",
      mediaPosition: s.attributes.media_position || 0,
      mediaDuration: s.attributes.media_duration || 0,
      mediaPositionUpdatedAt: s.attributes.media_position_updated_at || null,
      mediaContentType: s.attributes.media_content_type || "",
      mediaContentId: s.attributes.media_content_id || null,
      sourceList: s.attributes.source_list || [],
      source: s.attributes.source || null,
      activeQueue: s.attributes.active_queue || null,
    };
  }

  _syncProgress() {
    const sp = this._state.activeSpeaker;
    if (!sp) return;
    this._progressDuration = sp.mediaDuration || 0;
    if (sp.state === "playing" && sp.mediaPositionUpdatedAt) {
      const elapsed = (Date.now() - new Date(sp.mediaPositionUpdatedAt).getTime()) / 1000;
      this._progressPosition = (sp.mediaPosition || 0) + elapsed;
      this._startProgressTimer();
    } else {
      this._progressPosition = sp.mediaPosition || 0;
      this._stopProgressTimer();
    }
  }

  _startProgressTimer() {
    if (this._progressTimer) return;
    this._progressTimer = setInterval(() => {
      this._progressPosition += 1;
      if (this._progressDuration > 0 && this._progressPosition > this._progressDuration) {
        this._progressPosition = this._progressDuration;
        this._stopProgressTimer();
      }
      this._updateProgressUI();
    }, 1000);
  }

  _stopProgressTimer() {
    if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
  }

  _updateProgressUI() {
    const root = this.shadowRoot; if (!root) return;
    const fill = root.querySelector(".progress-fill");
    const el   = root.querySelector(".time-elapsed");
    const tot  = root.querySelector(".time-total");
    if (!fill) return;
    const pct = this._progressDuration > 0 ? Math.min(100, (this._progressPosition / this._progressDuration) * 100) : 0;
    fill.style.width = pct + "%";
    if (el) el.textContent = this._fmt(this._progressPosition);
    if (tot) tot.textContent = this._fmt(this._progressDuration);
  }

  _fmt(sec) {
    if (!sec || sec <= 0) return "0:00";
    const s = Math.floor(sec), m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, "0")}`;
  }

  // ─── Service calls ────────────────────────────────────────────────────────

  _call(domain, service, data) { if (this._hass) this._hass.callService(domain, service, data); }
  _target() { return this._state.activeSpeaker?.entityId; }

  _isRadio() {
    const sp = this._state.activeSpeaker; if (!sp) return false;
    const ct = sp.mediaContentType || "", id = sp.mediaContentId || "";
    return ct.includes("radio") || id.includes("radio://") || id.includes("tunein://");
  }

  _toggleSpeaker(entityId) {
    const active = [...this._state.activeSpeakers];
    const idx = active.indexOf(entityId);
    if (idx >= 0) { active.splice(idx, 1); this._call("media_player", "unjoin", { entity_id: entityId }); }
    else {
      active.push(entityId);
      if (active.length > 1) this._call("media_player", "join", { entity_id: active[0], group_members: active.slice(1) });
    }
    this._state.activeSpeakers = active;
    if (active.length > 0) { const sp = this._state.allSpeakers.find(s => s.entityId === active[0]); if (sp) this._state.activeSpeaker = sp; }
    this.render();
  }

  _selectAllVisible() {
    const all = this._state.visibleSpeakers.map(s => s.entityId);
    if (!all.length) return;
    this._state.activeSpeakers = all;
    if (all.length > 1) this._call("media_player", "join", { entity_id: all[0], group_members: all.slice(1) });
    this._state.activeSpeaker = this._state.visibleSpeakers[0];
    this.render();
  }

  _adjustVolume(delta) {
    const targets = this._state.activeSpeakers.length > 0 ? this._state.activeSpeakers : [this._target()].filter(Boolean);
    targets.forEach(id => {
      const s = this._hass?.states[id]; if (!s) return;
      const cur = Math.round((s.attributes.volume_level || 0) * 100);
      this._call("media_player", "volume_set", { entity_id: id, volume_level: Math.max(0, Math.min(100, cur + delta)) / 100 });
    });
  }

  _adjustSpeakerVolume(entityId, delta) {
    const s = this._hass?.states[entityId]; if (!s) return;
    const cur = Math.round((s.attributes.volume_level || 0) * 100);
    this._call("media_player", "volume_set", { entity_id: entityId, volume_level: Math.max(0, Math.min(100, cur + delta)) / 100 });
  }

  _toggleMute() {
    const targets = this._state.activeSpeakers.length > 0 ? this._state.activeSpeakers : [this._target()].filter(Boolean);
    const m = !this._state.isMuted; this._state.isMuted = m;
    targets.forEach(id => this._call("media_player", "volume_mute", { entity_id: id, is_volume_muted: m }));
    this.render();
  }

  _equaliseVolume() {
    (this._state.visibleSpeakers.length > 0 ? this._state.visibleSpeakers : this._state.allSpeakers)
      .forEach(s => this._call("media_player", "volume_set", { entity_id: s.entityId, volume_level: 0.01 }));
  }

  _selectSource(source) {
    if (this._target()) this._call("media_player", "select_source", { entity_id: this._target(), source });
    this._state.showSourcePopup = false; this.render();
  }

  async _doSearch() {
    const query = this._state.searchQuery.trim();
    if (!query || !this._target()) return;
    this._state.searching = true; this._state.searchResults = { library: [], catalog: [] }; this.render();
    try {
      const result = await this._hass.callWS({ type: "media_player/browse_media", entity_id: this._target(), media_content_type: "search", media_content_id: query });
      const library = [], catalog = [];
      (result?.children || []).forEach(item => {
        const obj = { uri: item.media_content_id, type: item.media_content_type || "track", name: item.title, artist: item.children_media_class || "", image: item.thumbnail, in_library: !(item.media_content_id || "").includes("catalog://") };
        if (obj.in_library) library.push(obj); else catalog.push(obj);
      });
      this._state.searchResults = { library, catalog };
    } catch (e) { console.warn("SoundFlow search", e); }
    this._state.searching = false; this.render();
  }

  _playItem(item) {
    const target = this._state.activeSpeakers[0] || this._target(); if (!target) return;
    this._call("media_player", "play_media", { entity_id: target, media_content_id: item.uri || item.id, media_content_type: item.type || "music" });
    this._state.searchQuery = ""; this._state.searchResults = { library: [], catalog: [] }; this._state.showQueuePopup = false; this.render();
  }

  _addToLibrary() {
    const sp = this._state.activeSpeaker; if (!sp?.mediaContentId) return;
    this._call("mass", "add_to_library", { media_type: sp.mediaContentType || "track", library_id: sp.mediaContentId });
  }

  async _loadQueue() {
    const target = this._target(); if (!target) return;
    this._state.loadingQueue = true; this.render();
    try {
      const result = await this._hass.callWS({ type: "media_player/browse_media", entity_id: target, media_content_type: "queue", media_content_id: "queue" });
      this._state.queue = result?.children || [];
    } catch (e) { this._state.queue = []; }
    this._state.loadingQueue = false; this.render();
  }

  _closeAllPopups() {
    this._state.showSourcePopup = this._state.showSpeakersPopup =
    this._state.showQueuePopup  = this._state.showSettingsPopup = false;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  render() {
    if (!this.shadowRoot) return;
    const sp = this._state.activeSpeaker;
    const isPlaying = sp?.state === "playing";
    const isActive  = isPlaying || sp?.state === "paused";
    this.shadowRoot.innerHTML = `<style>${this._styles()}</style>${this._state.showFullCard ? this._renderOverlay(sp, isPlaying) : this._renderMini(sp, isActive, isPlaying)}`;
    this._attachEvents();
    requestAnimationFrame(() => this._updateProgressUI());
  }

  _renderMini(sp, isActive, isPlaying) {
    if (!isActive) return `
      <div class="mini inactive" id="mini-open">
        <div class="mini-logo">${this._logo(20)}</div>
        <div class="mini-info"><div class="mini-title">SoundFlow</div><div class="mini-sub">Music Assistant</div></div>
        <div class="mini-hint">▶</div>
      </div>`;
    return `
      <div class="mini active" id="mini-open">
        <div class="mini-art" style="${sp?.artwork ? `background-image:url(${sp.artwork});background-size:cover;background-position:center` : "background:linear-gradient(135deg,#fc3c44,#c026d3,#6366f1)"}"></div>
        <div class="mini-info">
          <div class="mini-title">${this._esc(sp?.title || "SoundFlow")}</div>
          <div class="mini-sub">${this._esc(sp?.artist || sp?.name || "")}</div>
        </div>
        <div class="mini-controls">
          <button class="mini-btn" id="btn-mini-prev">⏮</button>
          <button class="mini-btn play" id="btn-mini-play">${isPlaying ? "⏸" : "▶"}</button>
          <button class="mini-btn" id="btn-mini-next">⏭</button>
        </div>
      </div>`;
  }

  _renderOverlay(sp, isPlaying) {
    const isRadio   = this._isRadio();
    const visible   = this._state.visibleSpeakers;
    const active    = this._state.activeSpeakers;
    const spLabel   = active.length === 0 ? "Colunas" : active.length === 1 ? (this._state.allSpeakers.find(s => s.entityId === active[0])?.name || "1 coluna") : `${active.length} colunas`;
    const srcLabel  = (sp?.source || this._state.sourceList[0] || "Fonte").replace("Music Assistant Queue", "MA Queue");
    const artStyle  = sp?.artwork ? `background-image:url(${sp.artwork});background-size:cover;background-position:center` : `background:linear-gradient(135deg,#fc3c44 0%,#c026d3 50%,#6366f1 100%)`;
    const pct       = this._progressDuration > 0 ? Math.min(100, (this._progressPosition / this._progressDuration) * 100) : 0;
    const volShow   = (() => { if (active.length > 0) { const s = this._state.allSpeakers.find(x => x.entityId === active[0]); return s?.volume ?? sp?.volume ?? 0; } return sp?.volume ?? 0; })();
    const isLib     = (sp?.source || "").toLowerCase().includes("library") || (sp?.mediaContentId || "").includes("library://");
    const showAddLib = !isRadio && !isLib && sp?.title && sp?.mediaContentId;
    const selGroup  = this._state.allGroups.find(g => g.entityId === this._state.selectedGroupId);

    return `
      <div class="overlay" id="overlay-bg">
        ${this._lgDefs()}
        <div class="card" id="card-stop">
          <div class="card-header">
            <button class="pill src-pill" id="btn-source">
              <span class="src-dot"></span>
              <span class="pill-text">${this._esc(srcLabel)}</span>
              <span class="caret">▾</span>
            </button>
            <div class="hdr-right">
              ${selGroup ? `<span class="grp-badge">🏠 ${this._esc(selGroup.name)}</span>` : ""}
              <button class="pill spk-pill" id="btn-speakers">
                <span class="pico">🔊</span>
                <span class="pill-text">${this._esc(spLabel)}</span>
                <span class="caret">▾</span>
              </button>
              ${!isRadio ? `<button class="icon-btn" id="btn-queue">≡</button>` : ""}
              <button class="icon-btn" id="btn-settings">⚙</button>
            </div>
            <button class="close-btn" id="btn-close">✕</button>
          </div>

          <div class="artwork-wrap">
            <div class="art-blur" ${sp?.artwork ? `style="background-image:url(${sp.artwork})"` : ""}></div>
            <div class="artwork" style="${artStyle}">${!sp?.artwork ? this._logo(64) : ""}</div>
          </div>

          <div class="track-info">
            <div class="track-title">${this._esc(sp?.title || "Nenhuma música a tocar")}</div>
            <div class="track-meta">${this._esc(sp?.artist || "")}${sp?.album ? ` · ${this._esc(sp.album)}` : ""}</div>
            ${showAddLib ? `<button class="add-lib-btn" id="btn-add-lib">+ Adicionar à biblioteca</button>` : ""}
          </div>

          ${isRadio ? `<div class="radio-badge">📻 Rádio ao vivo</div>` : `
          <div class="progress-wrap">
            <div class="progress-bar" id="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <div class="progress-times"><span class="time-elapsed">${this._fmt(this._progressPosition)}</span><span class="time-total">${this._fmt(this._progressDuration)}</span></div>
          </div>`}

          <div class="controls">
            <button class="ctrl ${sp?.shuffle ? "on" : ""}" id="btn-shuffle">⇄</button>
            <button class="ctrl" id="btn-prev">⏮</button>
            <button class="ctrl main" id="btn-play">${isPlaying ? "⏸" : "▶"}</button>
            <button class="ctrl" id="btn-next">⏭</button>
            <button class="ctrl ${sp?.repeat && sp.repeat !== "off" ? "on" : ""}" id="btn-repeat">↺${sp?.repeat === "one" ? "¹" : ""}</button>
          </div>

          <div class="vol-row">
            <button class="vpill" id="btn-mute">${this._state.isMuted ? "🔇" : "🔊"}</button>
            <button class="vpill" id="btn-vol-down">−</button>
            <span class="vdisp">${volShow}%</span>
            <button class="vpill" id="btn-vol-up">+</button>
            <button class="vpill eq" id="btn-eq">⇊ 1%</button>
          </div>

          ${!isRadio ? `
          <div class="search-section">
            <div class="search-bar">
              <span class="si">⌕</span>
              <input class="search-input" id="search-input" type="text" placeholder="Pesquisar música, artista, álbum..." value="${this._esc(this._state.searchQuery)}" autocomplete="off"/>
              <button class="search-btn" id="btn-search">🔍</button>
            </div>
            ${this._state.searching ? `<div class="hint">A pesquisar...</div>` : ""}
            ${this._renderResults()}
          </div>` : ""}

          <div class="footer"><span class="powered">powered by Music Assistant · v${SF_VERSION}</span></div>
        </div>

        ${this._state.showSourcePopup   ? this._renderSourcePopup()   : ""}
        ${this._state.showSpeakersPopup ? this._renderSpeakersPopup(visible, active) : ""}
        ${this._state.showQueuePopup    ? this._renderQueuePopup()    : ""}
        ${this._state.showSettingsPopup ? this._renderSettingsPopup() : ""}
      </div>`;
  }

  _renderSourcePopup() {
    const sources = this._state.sourceList, cur = this._state.activeSpeaker?.source || "";
    return `
      <div class="popup popup-left" id="source-popup">
        <div class="popup-title">Fonte de áudio</div>
        ${!sources.length ? `<div class="empty-msg">Nenhuma fonte disponível</div>` :
          sources.map(src => `
          <div class="popup-row ${src === cur ? "active" : ""}" data-source="${this._esc(src)}">
            <span class="src-ico">${src.includes("Music") ? "🎵" : src.includes("TV") ? "📺" : src.includes("Radio") || src.includes("Rádio") ? "📻" : "🔊"}</span>
            <span class="popup-name">${this._esc(src)}</span>
            ${src === cur ? `<span class="check">✓</span>` : ""}
          </div>`).join("")}
      </div>`;
  }

  _renderSpeakersPopup(visible, active) {
    return `
      <div class="popup popup-right" id="speakers-popup">
        <div class="popup-title">Colunas</div>
        ${visible.length ? `
        <div class="popup-actions">
          <button class="action-btn" id="btn-all-spk">🏠 Toda a casa</button>
          <button class="action-btn eq" id="btn-eq-popup">⇊ 1%</button>
        </div>` : ""}
        <div class="vol-hdr"><span class="vol-lbl">Volume individual</span></div>
        ${!visible.length ? `<div class="empty-msg">Nenhuma coluna encontrada.<br>Verifica o Music Assistant.</div>` :
          visible.map(s => `
          <div class="spk-row">
            <div class="spk-chk ${active.includes(s.entityId) ? "on" : ""}" data-speaker="${s.entityId}">
              ${active.includes(s.entityId) ? "✓" : ""}
            </div>
            <div class="spk-info">
              <div class="spk-name">${this._esc(s.name)}</div>
              <div class="spk-bar"><div class="spk-fill" style="width:${s.volume}%"></div></div>
              ${s.title ? `<div class="spk-playing">▶ ${this._esc(s.title)}</div>` : ""}
            </div>
            <div class="vol-ctrl">
              <button class="vol-btn" data-speaker="${s.entityId}" data-delta="-5">−</button>
              <span class="vol-val">${s.volume}%</span>
              <button class="vol-btn" data-speaker="${s.entityId}" data-delta="5">+</button>
            </div>
          </div>`).join("")}
      </div>`;
  }

  _renderQueuePopup() {
    return `
      <div class="popup popup-center" id="queue-popup">
        <div class="popup-title">Fila de reprodução</div>
        ${this._state.loadingQueue ? `<div class="hint">A carregar...</div>`
          : !this._state.queue.length ? `<div class="empty-msg">Fila vazia.</div>`
          : `<div class="queue-list">${this._state.queue.slice(0,30).map((item,i) => `
            <div class="result-row queue-item" data-uri="${this._esc(item.media_content_id||"")}" data-type="${item.media_content_type||"track"}">
              <div class="q-num">${i+1}</div>
              <div class="result-art" style="${item.thumbnail ? `background-image:url(${item.thumbnail});background-size:cover` : "background:linear-gradient(135deg,#fc3c44,#6366f1)"}"></div>
              <div class="result-info">
                <div class="result-title">${this._esc(item.title||"")}</div>
                <div class="result-sub">${this._esc(item.children_media_class||"")}</div>
              </div>
            </div>`).join("")}</div>`}
      </div>`;
  }

  _renderSettingsPopup() {
    const groups = this._state.allGroups, sel = this._state.selectedGroupId;
    return `
      <div class="popup popup-settings" id="settings-popup">
        <div class="popup-title">⚙ Definições</div>
        <div class="settings-sec">
          <div class="settings-lbl">Grupo de colunas</div>
          <div class="settings-desc">Filtra as colunas visíveis no popup de colunas</div>
          <div class="group-list">
            <div class="group-item ${!sel ? "active" : ""}" data-group="">
              <span class="grp-ico">🔊</span><span class="grp-name">Todas as colunas</span>
              ${!sel ? `<span class="check">✓</span>` : ""}
            </div>
            ${!groups.length ? `<div class="empty-msg" style="margin-top:8px">Nenhum grupo criado no Music Assistant.<br>Cria um grupo no MA para poder filtrar aqui.</div>`
              : groups.map(g => `
              <div class="group-item ${sel === g.entityId ? "active" : ""}" data-group="${g.entityId}">
                <span class="grp-ico">🏠</span><span class="grp-name">${this._esc(g.name)}</span>
                ${sel === g.entityId ? `<span class="check">✓</span>` : ""}
              </div>`).join("")}
          </div>
        </div>
        <div class="settings-sec">
          <div class="settings-lbl">Versão</div>
          <div class="settings-desc">SoundFlow Card v${SF_VERSION}</div>
        </div>
      </div>`;
  }

  _renderResults() {
    const lib = this._state.searchResults?.library || [];
    const cat = this._state.searchResults?.catalog || [];
    if (!lib.length && !cat.length) return "";
    const row = item => `
      <div class="result-row" data-uri="${this._esc(item.uri||"")}" data-type="${item.type||"track"}">
        <div class="result-art" style="${item.image ? `background-image:url(${item.image});background-size:cover` : "background:linear-gradient(135deg,#fc3c44,#6366f1)"}"></div>
        <div class="result-info"><div class="result-title">${this._esc(item.name||"")}</div><div class="result-sub">${this._esc(item.artist||"")}</div></div>
        <span class="badge ${item.in_library ? "badge-lib" : "badge-cat"}">${item.in_library ? "Biblioteca" : "Catálogo"}</span>
      </div>`;
    return `<div class="results-wrap">
      ${lib.length ? `<div class="results-lbl">Da tua biblioteca</div>${lib.map(row).join("")}` : ""}
      ${cat.length ? `<div class="results-lbl">Catálogo</div>${cat.map(row).join("")}` : ""}
    </div>`;
  }

  _lgDefs() { return `<svg style="position:absolute;width:0;height:0;pointer-events:none"><defs><filter id="lgf"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3" result="d"/><feGaussianBlur in="d" stdDeviation="0.5"/></filter></defs></svg>`; }

  _logo(sz) {
    const s = sz, s2 = s*2;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s2} ${s2}" fill="none">
      <path d="M${s*.18} ${s*1.73} Q${s*.55} ${s*.36} ${s} ${s} Q${s*1.45} ${s*1.64} ${s*1.82} ${s*.55}" stroke="white" stroke-width="${s*.13}" stroke-linecap="round"/>
      <path d="M${s*.18} ${s*1.73} Q${s*.55} ${s*.36} ${s} ${s} Q${s*1.45} ${s*1.64} ${s*1.82} ${s*.55}" stroke="rgba(255,255,255,0.22)" stroke-width="${s*.38}" stroke-linecap="round"/>
      <circle cx="${s*1.82}" cy="${s*.55}" r="${s*.15}" fill="white"/>
      <circle cx="${s*.18}" cy="${s*1.73}" r="${s*.15}" fill="white"/>
    </svg>`;
  }

  _esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ─── Events ───────────────────────────────────────────────────────────────

  _attachEvents() {
    const root = this.shadowRoot; if (!root) return;
    const $ = id => root.getElementById(id);

    $("mini-open")?.addEventListener("click", e => {
      const id = e.target.closest("button")?.id;
      if (id === "btn-mini-prev") this._call("media_player","media_previous_track",{entity_id:this._target()});
      else if (id === "btn-mini-play") { const p = this._state.activeSpeaker?.state==="playing"; this._call("media_player",p?"media_pause":"media_play",{entity_id:this._target()}); }
      else if (id === "btn-mini-next") this._call("media_player","media_next_track",{entity_id:this._target()});
      else { this._state.showFullCard=true; this.render(); }
    });

    $("overlay-bg")?.addEventListener("click", e => {
      if (e.target.id !== "overlay-bg") return;
      if (this._state.showSourcePopup||this._state.showSpeakersPopup||this._state.showQueuePopup||this._state.showSettingsPopup) { this._closeAllPopups(); this.render(); }
      else { this._state.showFullCard=false; this.render(); }
    });
    $("card-stop")?.addEventListener("click", e => e.stopPropagation());
    $("btn-close")?.addEventListener("click", () => { this._state.showFullCard=false; this._closeAllPopups(); this.render(); });

    $("btn-play")?.addEventListener("click",    () => { const p=this._state.activeSpeaker?.state==="playing"; this._call("media_player",p?"media_pause":"media_play",{entity_id:this._target()}); });
    $("btn-prev")?.addEventListener("click",    () => this._call("media_player","media_previous_track",{entity_id:this._target()}));
    $("btn-next")?.addEventListener("click",    () => this._call("media_player","media_next_track",{entity_id:this._target()}));
    $("btn-shuffle")?.addEventListener("click", () => this._call("media_player","shuffle_set",{entity_id:this._target(),shuffle:!this._state.activeSpeaker?.shuffle}));
    $("btn-repeat")?.addEventListener("click",  () => { const c=this._state.activeSpeaker?.repeat||"off"; this._call("media_player","repeat_set",{entity_id:this._target(),repeat:c==="off"?"one":c==="one"?"all":"off"}); });

    $("btn-vol-up")?.addEventListener("click",   () => this._adjustVolume(5));
    $("btn-vol-down")?.addEventListener("click", () => this._adjustVolume(-5));
    $("btn-mute")?.addEventListener("click",     () => this._toggleMute());
    $("btn-eq")?.addEventListener("click",       () => this._equaliseVolume());

    $("progress-bar")?.addEventListener("click", e => {
      if (!this._progressDuration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pos  = Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)) * this._progressDuration;
      this._call("media_player","media_seek",{entity_id:this._target(),seek_position:pos});
      this._progressPosition=pos; this._updateProgressUI();
    });

    $("btn-add-lib")?.addEventListener("click", () => this._addToLibrary());

    // Source popup
    $("btn-source")?.addEventListener("click", e => { e.stopPropagation(); this._state.showSourcePopup=!this._state.showSourcePopup; this._state.showSpeakersPopup=this._state.showQueuePopup=this._state.showSettingsPopup=false; this.render(); });
    $("source-popup")?.addEventListener("click", e => e.stopPropagation());
    root.querySelectorAll("[data-source]").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); this._selectSource(el.dataset.source); }));

    // Speakers popup
    $("btn-speakers")?.addEventListener("click", e => { e.stopPropagation(); this._state.showSpeakersPopup=!this._state.showSpeakersPopup; this._state.showSourcePopup=this._state.showQueuePopup=this._state.showSettingsPopup=false; this.render(); });
    $("speakers-popup")?.addEventListener("click", e => e.stopPropagation());
    root.querySelectorAll(".spk-chk").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); this._toggleSpeaker(el.dataset.speaker); }));
    root.querySelectorAll(".vol-btn").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); this._adjustSpeakerVolume(el.dataset.speaker,parseInt(el.dataset.delta)); }));
    $("btn-all-spk")?.addEventListener("click", e => { e.stopPropagation(); this._selectAllVisible(); });
    $("btn-eq-popup")?.addEventListener("click", e => { e.stopPropagation(); this._equaliseVolume(); });

    // Queue popup
    $("btn-queue")?.addEventListener("click", e => { e.stopPropagation(); const w=!this._state.showQueuePopup; this._state.showQueuePopup=w; this._state.showSourcePopup=this._state.showSpeakersPopup=this._state.showSettingsPopup=false; if(w) this._loadQueue(); else this.render(); });
    $("queue-popup")?.addEventListener("click", e => e.stopPropagation());
    root.querySelectorAll(".queue-item").forEach(el => el.addEventListener("click", () => { this._playItem({uri:el.dataset.uri,type:el.dataset.type}); this._state.showQueuePopup=false; }));

    // Settings popup
    $("btn-settings")?.addEventListener("click", e => { e.stopPropagation(); this._state.showSettingsPopup=!this._state.showSettingsPopup; this._state.showSourcePopup=this._state.showSpeakersPopup=this._state.showQueuePopup=false; this.render(); });
    $("settings-popup")?.addEventListener("click", e => e.stopPropagation());
    root.querySelectorAll(".group-item").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const gid = el.dataset.group || null;
      this._state.selectedGroupId = gid;
      try { gid ? localStorage.setItem("soundflow_speaker_group",gid) : localStorage.removeItem("soundflow_speaker_group"); } catch(_){}
      this._state.activeSpeakers=[]; this._state.activeSpeaker=null;
      this._updateState(); this._state.showSettingsPopup=false; this.render();
    }));

    // Search
    const inp = $("search-input");
    if (inp) {
      if (this._searchFocused) { inp.focus(); inp.setSelectionRange(inp.value.length,inp.value.length); }
      inp.addEventListener("focus",  () => { this._searchFocused=true; });
      inp.addEventListener("blur",   () => { this._searchFocused=false; });
      inp.addEventListener("input",  e => { this._state.searchQuery=e.target.value; });
      inp.addEventListener("keydown",e => { e.stopPropagation(); if(e.key==="Enter"){e.preventDefault();this._state.searchQuery=inp.value;this._doSearch();} });
      inp.addEventListener("keyup",  e => e.stopPropagation());
    }
    $("btn-search")?.addEventListener("click", () => { this._state.searchQuery=$("search-input")?.value||this._state.searchQuery; this._doSearch(); });
    root.querySelectorAll(".result-row:not(.queue-item)").forEach(el => el.addEventListener("click", () => this._playItem({uri:el.dataset.uri,id:el.dataset.uri,type:el.dataset.type})));
  }

  // ─── Styles ───────────────────────────────────────────────────────────────

  _styles() { return `
    :host{display:block}

    /* Mini */
    .mini{background:rgba(14,14,22,.76);backdrop-filter:blur(28px) saturate(1.8);-webkit-backdrop-filter:blur(28px) saturate(1.8);border:.5px solid rgba(255,255,255,.14);border-radius:20px;padding:11px 14px;display:flex;align-items:center;gap:12px;cursor:pointer;position:relative;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.1);transition:border-color .2s,box-shadow .2s;font-family:-apple-system,'Helvetica Neue',sans-serif}
    .mini::before{content:'';position:absolute;inset:0;border-radius:20px;background:linear-gradient(135deg,rgba(255,255,255,.07) 0%,transparent 60%);pointer-events:none}
    .mini:hover{border-color:rgba(255,255,255,.24);box-shadow:0 12px 40px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.14)}
    .mini-logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#fc3c44,#c026d3,#6366f1);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 12px rgba(252,60,68,.4)}
    .mini-art{width:40px;height:40px;border-radius:10px;flex-shrink:0;box-shadow:0 4px 12px rgba(0,0,0,.3)}
    .mini-info{flex:1;min-width:0}
    .mini-title{font-size:14px;font-weight:500;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mini-sub{font-size:12px;color:rgba(255,255,255,.46);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mini-hint{font-size:16px;color:rgba(255,255,255,.28)}
    .mini-controls{display:flex;align-items:center;gap:5px}
    .mini-btn{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.1);border:.5px solid rgba(255,255,255,.15);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;backdrop-filter:blur(8px)}
    .mini-btn:hover{background:rgba(255,255,255,.2)}
    .mini-btn.play{background:rgba(255,255,255,.92);color:#111;width:34px;height:34px;font-size:14px;box-shadow:0 2px 8px rgba(255,255,255,.3)}

    /* Overlay */
    .overlay{position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;animation:fadeIn .22s ease}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}

    /* Card */
    .card{background:rgba(8,8,16,.85);backdrop-filter:blur(56px) saturate(2.2) brightness(1.06);-webkit-backdrop-filter:blur(56px) saturate(2.2) brightness(1.06);border:.5px solid rgba(255,255,255,.13);border-radius:36px;padding:22px;width:100%;max-width:384px;max-height:90vh;overflow-y:auto;position:relative;font-family:-apple-system,'Helvetica Neue',sans-serif;box-shadow:0 32px 80px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.1);animation:cardIn .28s cubic-bezier(.34,1.3,.64,1)}
    @keyframes cardIn{from{opacity:0;transform:scale(.93) translateY(14px)}to{opacity:1;transform:none}}
    .card::before{content:'';position:absolute;inset:0;border-radius:36px;background:linear-gradient(160deg,rgba(255,255,255,.07) 0%,rgba(255,255,255,.02) 40%,transparent 100%);pointer-events:none}
    .card::after{content:'';position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent)}
    .card::-webkit-scrollbar{width:4px}
    .card::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}

    /* Header */
    .card-header{display:flex;align-items:center;gap:7px;margin-bottom:18px;flex-wrap:nowrap}
    .hdr-right{display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0}
    .pill{background:rgba(255,255,255,.08);backdrop-filter:blur(16px);border:.5px solid rgba(255,255,255,.14);border-radius:20px;padding:6px 11px;display:flex;align-items:center;gap:5px;cursor:pointer;color:#fff;font-size:12px;transition:background .15s;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.07);max-width:130px;overflow:hidden}
    .pill:hover{background:rgba(255,255,255,.14)}
    .pill-text{overflow:hidden;text-overflow:ellipsis;font-size:12px}
    .pico{font-size:13px}
    .src-dot{width:7px;height:7px;border-radius:50%;background:#fc3c44;box-shadow:0 0 6px rgba(252,60,68,.6);flex-shrink:0}
    .caret{font-size:9px;color:rgba(255,255,255,.38)}
    .grp-badge{font-size:11px;color:rgba(255,255,255,.45);white-space:nowrap}
    .icon-btn{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.08);border:.5px solid rgba(255,255,255,.12);color:rgba(255,255,255,.62);cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;transition:background .15s;flex-shrink:0}
    .icon-btn:hover{background:rgba(255,255,255,.16)}
    .close-btn{width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.08);border:.5px solid rgba(255,255,255,.12);color:rgba(255,255,255,.52);cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s}
    .close-btn:hover{background:rgba(255,255,255,.16)}

    /* Artwork */
    .artwork-wrap{position:relative;width:172px;height:172px;margin:0 auto 18px}
    .art-blur{position:absolute;inset:-24px;background-size:cover;background-position:center;filter:blur(32px) saturate(1.6);opacity:.3;border-radius:50%;z-index:0}
    .artwork{position:relative;z-index:1;width:172px;height:172px;border-radius:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 24px 64px rgba(0,0,0,.48),inset 0 0 0 .5px rgba(255,255,255,.1);transition:transform .3s}
    .artwork:hover{transform:scale(1.02)}

    /* Track info */
    .track-info{text-align:center;margin-bottom:14px}
    .track-title{font-size:17px;font-weight:600;color:#fff;margin-bottom:4px;letter-spacing:-.3px}
    .track-meta{font-size:13px;color:rgba(255,255,255,.5)}
    .add-lib-btn{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.07);border:.5px solid rgba(255,255,255,.12);border-radius:12px;padding:5px 11px;margin-top:8px;font-size:11px;color:rgba(255,255,255,.52);cursor:pointer;transition:background .15s}
    .add-lib-btn:hover{background:rgba(255,255,255,.12)}
    .radio-badge{text-align:center;font-size:12px;color:rgba(255,255,255,.36);margin-bottom:14px;letter-spacing:.04em}

    /* Progress */
    .progress-wrap{margin-bottom:14px}
    .progress-bar{width:100%;height:4px;background:rgba(255,255,255,.1);border-radius:2px;margin-bottom:5px;cursor:pointer;position:relative;transition:height .15s}
    .progress-bar:hover{height:6px}
    .progress-fill{width:0%;height:100%;background:rgba(255,255,255,.82);border-radius:2px;transition:width .25s linear;position:relative}
    .progress-fill::after{content:'';position:absolute;right:-5px;top:50%;transform:translateY(-50%);width:11px;height:11px;background:#fff;border-radius:50%;opacity:0;transition:opacity .15s}
    .progress-bar:hover .progress-fill::after{opacity:1}
    .progress-times{display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,.26)}

    /* Controls */
    .controls{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:16px}
    .ctrl{background:none;border:none;cursor:pointer;color:rgba(255,255,255,.36);font-size:20px;padding:6px;transition:color .15s,transform .1s;border-radius:50%}
    .ctrl:hover{color:rgba(255,255,255,.7)}
    .ctrl:active{transform:scale(.92)}
    .ctrl.on{color:#fc3c44}
    .ctrl.main{width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.92);color:#111;font-size:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(255,255,255,.22),inset 0 0 0 .5px rgba(255,255,255,.5);transition:transform .1s,box-shadow .15s}
    .ctrl.main:hover{box-shadow:0 6px 28px rgba(255,255,255,.32),inset 0 0 0 .5px rgba(255,255,255,.6)}
    .ctrl.main:active{transform:scale(.94)}

    /* Volume */
    .vol-row{display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:16px}
    .vpill{background:rgba(255,255,255,.08);border:.5px solid rgba(255,255,255,.14);border-radius:22px;padding:7px 15px;color:rgba(255,255,255,.8);font-size:15px;cursor:pointer;min-width:42px;text-align:center;transition:background .15s,transform .1s;box-shadow:0 2px 8px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.07)}
    .vpill:hover{background:rgba(255,255,255,.15)}
    .vpill:active{transform:scale(.95)}
    .vdisp{font-size:13px;font-weight:500;color:rgba(255,255,255,.65);min-width:42px;text-align:center;background:rgba(255,255,255,.06);border:.5px solid rgba(255,255,255,.1);border-radius:22px;padding:7px 10px}
    .vpill.eq{font-size:11px;padding:7px 11px;color:rgba(255,255,255,.48)}

    /* Search */
    .search-section{margin-bottom:14px}
    .search-bar{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.07);border:.5px solid rgba(255,255,255,.11);border-radius:15px;padding:9px 12px}
    .si{font-size:15px;color:rgba(255,255,255,.26)}
    .search-input{background:none;border:none;outline:none;color:#fff;font-size:13px;flex:1;font-family:-apple-system,sans-serif}
    .search-input::placeholder{color:rgba(255,255,255,.2)}
    .search-btn{background:none;border:none;cursor:pointer;font-size:16px;flex-shrink:0}
    .hint{font-size:12px;color:rgba(255,255,255,.3);text-align:center;margin-top:6px}

    /* Results */
    .results-wrap{margin-top:8px;max-height:210px;overflow-y:auto}
    .results-wrap::-webkit-scrollbar{width:3px}
    .results-wrap::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}
    .results-lbl{font-size:10px;color:rgba(255,255,255,.24);text-transform:uppercase;letter-spacing:.07em;margin:8px 0 4px}
    .result-row{display:flex;align-items:center;gap:10px;padding:7px 6px;border-radius:12px;cursor:pointer;margin-bottom:2px;transition:background .15s}
    .result-row:hover{background:rgba(255,255,255,.07)}
    .result-art{width:36px;height:36px;border-radius:8px;flex-shrink:0}
    .result-info{flex:1;min-width:0}
    .result-title{font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .result-sub{font-size:11px;color:rgba(255,255,255,.36)}
    .badge{font-size:10px;padding:2px 7px;border-radius:8px;white-space:nowrap;flex-shrink:0}
    .badge-lib{background:rgba(48,209,88,.18);color:#30d158}
    .badge-cat{background:rgba(252,60,68,.18);color:#fc3c44}

    /* Footer */
    .footer{display:flex;justify-content:center;padding-top:6px}
    .powered{font-size:10px;color:rgba(255,255,255,.16);letter-spacing:.05em}

    /* Popups */
    .popup{position:absolute;top:68px;background:rgba(10,10,18,.93);backdrop-filter:blur(44px) saturate(2);-webkit-backdrop-filter:blur(44px) saturate(2);border:.5px solid rgba(255,255,255,.12);border-radius:26px;padding:18px;width:272px;z-index:200;font-family:-apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.08);animation:popIn .18s cubic-bezier(.34,1.3,.64,1)}
    @keyframes popIn{from{opacity:0;transform:scale(.92) translateY(-8px)}to{opacity:1;transform:none}}
    .popup::before{content:'';position:absolute;inset:0;border-radius:26px;background:linear-gradient(160deg,rgba(255,255,255,.06),transparent 60%);pointer-events:none}
    .popup-left{left:16px}
    .popup-right{right:16px}
    .popup-center{left:50%;transform:translateX(-50%);width:320px;max-width:calc(100vw - 32px)}
    .popup-settings{left:50%;transform:translateX(-50%);width:300px}
    .popup-title{font-size:14px;font-weight:600;color:#fff;margin-bottom:12px}
    .popup-row{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:13px;cursor:pointer;margin-bottom:4px;transition:background .15s}
    .popup-row:hover{background:rgba(255,255,255,.07)}
    .popup-row.active{background:rgba(252,60,68,.14)}
    .src-ico{font-size:18px;flex-shrink:0}
    .popup-name{flex:1;font-size:13px;color:#fff}
    .check{color:#fc3c44;font-size:14px;flex-shrink:0}
    .empty-msg{font-size:12px;color:rgba(255,255,255,.3);text-align:center;padding:10px 0;line-height:1.6}

    /* Speakers */
    .popup-actions{display:flex;gap:6px;margin-bottom:10px}
    .action-btn{flex:1;padding:8px;background:rgba(255,255,255,.07);border:.5px solid rgba(255,255,255,.11);border-radius:12px;color:rgba(255,255,255,.72);font-size:12px;cursor:pointer;transition:background .15s}
    .action-btn:hover{background:rgba(255,255,255,.13)}
    .action-btn.eq{font-size:11px}
    .vol-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    .vol-lbl{font-size:10px;color:rgba(255,255,255,.24);text-transform:uppercase;letter-spacing:.06em}
    .spk-row{display:flex;align-items:center;gap:8px;padding:5px 2px;margin-bottom:5px}
    .spk-chk{width:20px;height:20px;border-radius:6px;border:1.5px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;font-size:11px;color:#fff;transition:background .15s}
    .spk-chk.on{background:#fc3c44;border-color:#fc3c44;box-shadow:0 0 8px rgba(252,60,68,.4)}
    .spk-info{flex:1;min-width:0}
    .spk-name{font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .spk-bar{width:100%;height:2px;background:rgba(255,255,255,.08);border-radius:1px;margin-top:3px}
    .spk-fill{height:100%;border-radius:1px;background:rgba(255,255,255,.38)}
    .spk-playing{font-size:10px;color:rgba(48,209,88,.68);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .vol-ctrl{display:flex;align-items:center;gap:4px}
    .vol-btn{width:24px;height:24px;border-radius:7px;background:rgba(255,255,255,.08);border:.5px solid rgba(255,255,255,.11);color:#fff;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
    .vol-btn:hover{background:rgba(255,255,255,.18)}
    .vol-val{font-size:11px;color:rgba(255,255,255,.44);min-width:28px;text-align:center}

    /* Queue */
    .queue-list{max-height:280px;overflow-y:auto}
    .queue-list::-webkit-scrollbar{width:3px}
    .queue-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}
    .q-num{font-size:11px;color:rgba(255,255,255,.26);min-width:18px;text-align:center;flex-shrink:0}

    /* Settings */
    .settings-sec{margin-bottom:16px}
    .settings-lbl{font-size:11px;font-weight:600;color:rgba(255,255,255,.68);margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em}
    .settings-desc{font-size:11px;color:rgba(255,255,255,.3);margin-bottom:10px}
    .group-list{display:flex;flex-direction:column;gap:4px}
    .group-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:13px;cursor:pointer;transition:background .15s}
    .group-item:hover{background:rgba(255,255,255,.07)}
    .group-item.active{background:rgba(252,60,68,.14)}
    .grp-ico{font-size:16px;flex-shrink:0}
    .grp-name{flex:1;font-size:13px;color:#fff}
  `; }
}

customElements.define("soundflow-card", SoundFlowCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "soundflow-card",
  name: "SoundFlow",
  description: "Music Assistant — Liquid Glass iOS 26",
  preview: true,
  documentationURL: "https://github.com/soundflow-dev/soundflow",
});

console.info(
  `%c SOUNDFLOW %c v${SF_VERSION} `,
  "background:linear-gradient(90deg,#fc3c44,#c026d3);color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px;",
  "background:#0c0c14;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0;"
);
