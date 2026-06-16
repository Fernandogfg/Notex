/**
 * Notex — anotações rápidas e organizadas para Foundry VTT.
 *
 * Duas zonas:
 *  1. Rascunho rápido — texto puro, salvo em user flag, auto-save com debounce.
 *  2. Notas organizadas — cada nota é uma JournalEntry, editada inline na
 *     própria janela via <prose-mirror>. Organização:
 *       Notex (raiz)  └── <usuário> (OWNER)  └── notas
 *
 * Substituto moderno do Easy Notes. Compatível com Foundry V13/V14.
 */

const MODULE_ID = "notex";
const SCRATCH_FLAG = "scratch";
const OWNERSHIP = CONST.DOCUMENT_OWNERSHIP_LEVELS;

/* -------------------------------------------- */
/*  Pastas e ownership                           */
/* -------------------------------------------- */

const NotexFolders = {
  get rootName() {
    return game.modules.get(MODULE_ID)?.flags?.[MODULE_ID]?.rootFolderName ?? "Notex";
  },

  async ensureRoot() {
    let root = game.folders.find(
      (f) => f.type === "JournalEntry" && f.name === this.rootName && !f.folder
    );
    if (root) return root;
    if (!game.user.isGM) return null;
    return Folder.create({ name: this.rootName, type: "JournalEntry", color: "#4b2e83" });
  },

  async ensureUserFolder(user = game.user) {
    const root = await this.ensureRoot();
    if (!root) return null;

    let folder = game.folders.find(
      (f) =>
        f.type === "JournalEntry" &&
        f.folder?.id === root.id &&
        f.getFlag(MODULE_ID, "userId") === user.id
    );
    if (folder) return folder;
    if (user.id !== game.user.id && !game.user.isGM) return null;

    return Folder.create({
      name: user.name,
      type: "JournalEntry",
      folder: root.id,
      ownership: { default: OWNERSHIP.NONE, [user.id]: OWNERSHIP.OWNER },
      flags: { [MODULE_ID]: { userId: user.id } }
    });
  },

  /** Uma JournalEntry é uma nota Notex se tiver a flag userId do módulo. */
  isNotexNote(doc) {
    const entry = this.resolveNote(doc);
    return !!entry;
  },

  /** Resolve o JournalEntry de uma nota Notex a partir de uma entry ou página. */
  resolveNote(doc) {
    if (!doc) return null;
    // Se for uma página, sobe para a JournalEntry-pai.
    const entry = doc.documentName === "JournalEntryPage" ? doc.parent : doc;
    if (entry?.documentName === "JournalEntry" && entry.getFlag?.(MODULE_ID, "userId")) {
      return entry;
    }
    return null;
  }
};

/* -------------------------------------------- */
/*  Notas (JournalEntry) e rascunho (user flag)  */
/* -------------------------------------------- */

const NotexData = {
  /** Pasta-raiz do usuário (Notex › usuário). */
  async userRoot(user = game.user) {
    return NotexFolders.ensureUserFolder(user);
  },

  /** IDs de todas as pastas na subárvore da pasta do usuário (inclui a raiz). */
  folderSubtreeIds(rootFolder) {
    const ids = new Set([rootFolder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of game.folders) {
        if (f.type !== "JournalEntry") continue;
        if (f.folder && ids.has(f.folder.id) && !ids.has(f.id)) {
          ids.add(f.id);
          changed = true;
        }
      }
    }
    return ids;
  },

  /** Todas as notas do usuário (em qualquer pasta da subárvore). */
  async listNotes(user = game.user) {
    const root = await this.userRoot(user);
    if (!root) return [];
    const ids = this.folderSubtreeIds(root);
    return game.journal.filter((j) => j.folder && ids.has(j.folder.id));
  },

  /** Subpastas diretas de uma pasta. */
  childFolders(folder) {
    return game.folders.filter(
      (f) => f.type === "JournalEntry" && f.folder?.id === folder.id
    );
  },

  /** Notas diretamente dentro de uma pasta (não recursivo). */
  notesInFolder(folder) {
    return game.journal.filter((j) => j.folder?.id === folder.id);
  },

  /** Cria uma nota dentro de uma pasta (padrão: raiz do usuário). */
  async createNote(name, folderId = null) {
    const root = await this.userRoot();
    if (!root) return null;
    return JournalEntry.create({
      name: name || game.i18n.localize("NOTEX.NewNoteName"),
      folder: folderId || root.id,
      ownership: { default: OWNERSHIP.NONE, [game.user.id]: OWNERSHIP.OWNER },
      flags: { [MODULE_ID]: { userId: game.user.id } },
      pages: [{ name: name || game.i18n.localize("NOTEX.NewNoteName"), type: "text", text: { content: "", format: 1 } }]
    });
  },

  /** Cria uma subpasta dentro de uma pasta (padrão: raiz do usuário). */
  async createFolder(name, parentId = null) {
    const root = await this.userRoot();
    if (!root) return null;
    return Folder.create({
      name: name || game.i18n.localize("NOTEX.NewFolderName"),
      type: "JournalEntry",
      folder: parentId || root.id,
      ownership: { default: OWNERSHIP.NONE, [game.user.id]: OWNERSHIP.OWNER },
      flags: { [MODULE_ID]: { userId: game.user.id } }
    });
  },

  /** Primeira página de texto de uma nota (criamos sempre com uma). */
  firstPage(entry) {
    return entry?.pages.find((p) => p.type === "text") ?? entry?.pages.contents[0] ?? null;
  },

  isPinned(note) {
    return !!note?.getFlag(MODULE_ID, "pinned");
  },

  async togglePin(note) {
    return note.setFlag(MODULE_ID, "pinned", !this.isPinned(note));
  },

  getColor(note) {
    return note?.getFlag(MODULE_ID, "color") ?? "";
  },

  async setColor(note, color) {
    if (color) return note.setFlag(MODULE_ID, "color", color);
    return note.unsetFlag(MODULE_ID, "color");
  },

  getScratch() {
    return game.user.getFlag(MODULE_ID, SCRATCH_FLAG) ?? "";
  },

  async setScratch(value) {
    return game.user.setFlag(MODULE_ID, SCRATCH_FLAG, value ?? "");
  }
};

/* -------------------------------------------- */
/*  UI: aplicação principal                      */
/* -------------------------------------------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class NotexApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  /** Id da nota atualmente aberta no editor inline. */
  #activeNoteId = null;

  /** Timer de debounce do auto-save do rascunho. */
  #scratchTimer = null;

  /** Instâncias de DragDrop ligadas à janela. */
  #dragDrop = [];

  /** Elemento <prose-mirror> vivo no DOM (recriado por nota). */
  #editorEl = null;

  /** Id da nota que a instância atual do editor está editando. */
  #editorNoteId = null;

  /** Termo de busca atual (filtra notas por título e conteúdo). */
  #searchTerm = "";

  /** Timer de debounce da busca. */
  #searchTimer = null;

  /** Se a nota ativa está em modo edição (true) ou visualização (false). */
  #editMode = false;

  /** IDs de pastas recolhidas na árvore (visual, não persiste). */
  #collapsedFolders = new Set();

  /** Controla o interceptador de cliques em links (para removê-lo no close). */
  #linkAbort = null;

  static open() {
    if (!this.#instance) this.#instance = new NotexApp();
    this.#instance.render(true);
    return this.#instance;
  }

  static get current() {
    return this.#instance;
  }

  static DEFAULT_OPTIONS = {
    id: "notex-app",
    classes: ["notex", "notex-app"],
    tag: "div",
    window: { title: "NOTEX.Title", icon: "fas fa-note-sticky", resizable: true },
    position: { width: 760, height: 600 },
    actions: {
      createNote: NotexApp.#onCreateNote,
      createNoteHere: NotexApp.#onCreateNoteHere,
      createFolder: NotexApp.#onCreateFolder,
      createFolderHere: NotexApp.#onCreateFolderHere,
      deleteFolder: NotexApp.#onDeleteFolder,
      toggleFolder: NotexApp.#onToggleFolder,
      togglePin: NotexApp.#onTogglePin,
      pickColor: NotexApp.#onPickColor,
      selectNote: NotexApp.#onSelectNote,
      editNote: NotexApp.#onEditNote,
      saveAndView: NotexApp.#onSaveAndView,
      deleteNote: NotexApp.#onDeleteNote,
      copyLink: NotexApp.#onCopyLink
    }
  };

  static PARTS = {
    body: { template: "modules/notex/templates/notex-app.hbs", root: true }
  };

  async _prepareContext(_options) {
    if (this.#activeNoteId && !game.journal.get(this.#activeNoteId)) {
      this.#activeNoteId = null;
    }

    const term = this.#searchTerm.trim().toLowerCase();
    const noteVM = (n) => ({
      id: n.id,
      uuid: n.uuid,
      name: n.name,
      active: n.id === this.#activeNoteId,
      pinned: NotexData.isPinned(n),
      color: NotexData.getColor(n)
    });

    let pinned = [];
    let tree = [];
    let flat = [];

    if (term) {
      // Busca: lista plana filtrada por título OU conteúdo.
      const all = (await NotexData.listNotes()).sort((a, b) => (a.sort || 0) - (b.sort || 0));
      flat = all
        .filter((n) => {
          const inTitle = n.name.toLowerCase().includes(term);
          const raw = NotexData.firstPage(n)?.text?.content ?? "";
          return inTitle || NotexApp.#stripHtml(raw).toLowerCase().includes(term);
        })
        .map(noteVM);
    } else {
      // Sem busca: pinadas no topo + árvore de pastas a partir da raiz do usuário.
      const allNotes = await NotexData.listNotes();
      pinned = allNotes.filter((n) => NotexData.isPinned(n)).map(noteVM);

      const root = await NotexData.userRoot();
      if (root) tree = this.#buildTree(root);
    }

    const activeEntry = this.#activeNoteId ? game.journal.get(this.#activeNoteId) : null;
    const activePage = NotexData.firstPage(activeEntry);
    const rawContent = activePage?.text?.content ?? "";

    let enriched = "";
    if (activeEntry && !this.#editMode) {
      enriched = await foundry.applications.ux.TextEditor.implementation.enrichHTML(rawContent, {
        relativeTo: activePage,
        secrets: activeEntry.isOwner
      });
    }

    return {
      scratch: NotexData.getScratch(),
      pinned,
      tree,
      flat,
      hasPinned: pinned.length > 0,
      searchTerm: this.#searchTerm,
      isSearching: !!term,
      noResults: !!term && flat.length === 0,
      isEmpty: !term && tree.length === 0 && pinned.length === 0,
      hasActive: !!activeEntry,
      editMode: this.#editMode,
      activeId: activeEntry?.id ?? "",
      activeName: activeEntry?.name ?? "",
      activeContent: rawContent,
      activeEnriched: enriched,
      activeUuid: activePage?.uuid ?? ""
    };
  }

  /** Extrai texto puro de um fragmento HTML (para busca no conteúdo). */
  static #stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  }

  /**
   * Constrói a árvore (pastas + notas) a partir de uma pasta, recursivamente.
   * Retorna uma lista de nós: pastas (com filhos) e notas, já ordenados.
   */
  #buildTree(folder) {
    const noteVM = (n) => ({
      type: "note",
      id: n.id,
      uuid: n.uuid,
      name: n.name,
      active: n.id === this.#activeNoteId,
      pinned: NotexData.isPinned(n),
      color: NotexData.getColor(n)
    });

    const subfolders = NotexData.childFolders(folder)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map((f) => ({
        type: "folder",
        id: f.id,
        name: f.name,
        color: f.color || "",
        collapsed: this.#collapsedFolders.has(f.id),
        children: this.#collapsedFolders.has(f.id) ? [] : this.#buildTree(f)
      }));

    const notes = NotexData.notesInFolder(folder)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(noteVM);

    // Pastas primeiro, depois notas (convenção de gerenciadores de arquivos).
    return [...subfolders, ...notes];
  }

  async _onRender(_context, _options) {
    const root = this.element;
    this.#wireScratch(root);
    this.#wireSearch(root);
    this.#wireTitle(root);
    await this.#mountEditor(root);
    this.#wireSplitters(root);
    this.#wireDragDrop(root);
    this.#wireContentLinks(root);
  }

  async _onClose(_options) {
    this.#linkAbort?.abort();
    this.#linkAbort = null;
    await this.#flushActiveEditor();
    await this.#destroyEditor();
  }

  /* ---- Rascunho ---- */
  #wireScratch(root) {
    const scratch = root.querySelector(".notex-scratch");
    if (!scratch) return;
    scratch.addEventListener("input", () => {
      clearTimeout(this.#scratchTimer);
      this.#scratchTimer = setTimeout(() => NotexData.setScratch(scratch.value), 500);
    });
    scratch.addEventListener("blur", () => {
      clearTimeout(this.#scratchTimer);
      NotexData.setScratch(scratch.value);
    });
  }

  /* ---- Busca ---- */
  #wireSearch(root) {
    const input = root.querySelector(".notex-search-input");
    if (!input) return;

    input.addEventListener("input", () => {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => {
        this.#searchTerm = input.value;
        // Marca para devolver o foco ao campo após o re-render.
        this._restoreSearchFocus = true;
        this.render();
      }, 200);
    });

    // Esc limpa a busca.
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && input.value) {
        ev.preventDefault();
        input.value = "";
        this.#searchTerm = "";
        this._restoreSearchFocus = true;
        this.render();
      }
    });

    // Botão de limpar (x).
    const clear = root.querySelector(".notex-search-clear");
    clear?.addEventListener("click", () => {
      this.#searchTerm = "";
      this._restoreSearchFocus = true;
      this.render();
    });

    // Devolve o foco ao campo após re-render disparado pela própria busca.
    if (this._restoreSearchFocus) {
      this._restoreSearchFocus = false;
      input.focus();
      const v = input.value;
      input.value = "";
      input.value = v; // joga o cursor para o fim
    }
  }

  /* ---- Título ao vivo ---- */
  #wireTitle(root) {
    const titleInput = root.querySelector(".notex-active-title");
    if (!titleInput) return;
    const commit = async () => {
      const entry = game.journal.get(this.#activeNoteId);
      if (entry && titleInput.value.trim() && titleInput.value !== entry.name) {
        await this.#flushActiveEditor();
        const newName = titleInput.value.trim();
        await entry.update({ name: newName });
        // Mantém o nome da página em sincronia, para o Journal nativo exibir
        // o título correto em vez de um placeholder.
        const page = NotexData.firstPage(entry);
        if (page && page.name !== newName) await page.update({ name: newName });
      }
    };
    titleInput.addEventListener("change", commit);
    titleInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") titleInput.blur();
    });
  }

  /* ---- Editor inline (elemento recriado por nota) ---- */

  /**
   * Cria um <prose-mirror> NOVO a cada render, dentro do mount vazio.
   * Como o elemento é construído do zero toda vez (nunca reaproveitado),
   * não há vazamento de conteúdo entre notas.
   */
  async #mountEditor(root) {
    const mount = root.querySelector(".notex-editor-mount");
    if (!mount) return;
    mount.replaceChildren();
    this.#editorEl = null;
    this.#editorNoteId = null;

    if (!this.#activeNoteId) return;
    const entry = game.journal.get(this.#activeNoteId);
    const page = NotexData.firstPage(entry);
    if (!page) return;

    // Em modo visualização não montamos o ProseMirror: o conteúdo enriquecido
    // já está renderizado no template. Os links são tratados em #wireContentLinks.
    if (!this.#editMode) return;

    const noteId = this.#activeNoteId;
    this.#editorNoteId = noteId;
    const initial = page.text?.content ?? "";

    // Forma OFICIAL de instanciar o editor. `toggled: false` = editor sempre
    // ativo (sem precisar clicar para ativar). `value` vem do FormInputConfig.
    const PM = foundry.applications.elements.HTMLProseMirrorElement;
    const pm = PM.create({
      name: "content",
      value: initial,
      toggled: false,
      collaborate: false
    });
    mount.appendChild(pm);
    this.#editorEl = pm;

    pm.addEventListener("save", () => {
      const content = this.#readCommitted(pm);
      this.#saveContentFor(noteId, content);
    });
  }

  /**
   * Trata cliques em content-links no conteúdo da nota. Delegado na janela
   * inteira (this.element), que sempre existe — sem depender do timing da view.
   * Links de notas Notex navegam dentro do Notex; o resto abre normalmente.
   */
  #wireContentLinks(root) {
    this.#linkAbort?.abort();
    this.#linkAbort = new AbortController();

    // Registramos no DOCUMENTO em fase de captura: é o nível mais alto, então
    // rodamos antes de qualquer handler do Foundry (que fica no body), e o
    // stopImmediatePropagation impede que ele dispare em seguida.
    document.addEventListener(
      "click",
      async (event) => {
        const link = event.target.closest?.("a.content-link[data-uuid]");
        if (!link) return;
        // Só links dentro da nossa janela e na área de visualização.
        if (!root.contains(link) || !link.closest(".notex-view")) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const doc = await fromUuid(link.dataset.uuid);
        const note = NotexFolders.resolveNote(doc);
        if (note) {
          await this.#flushActiveEditor();
          this.#activeNoteId = note.id;
          this.#editMode = false;
          this.render();
        } else if (doc) {
          (doc.sheet ?? doc.parent?.sheet)?.render(true);
        }
      },
      { capture: true, signal: this.#linkAbort.signal }
    );
  }

  /** Remove o editor atual do DOM, se houver. */
  #destroyEditor() {
    this.#editorEl?.remove();
    this.#editorEl = null;
    this.#editorNoteId = null;
  }

  /** Lê o conteúdo JÁ commitado, sem forçar save (seguro dentro do handler "save"). */
  #readCommitted(pm) {
    let content = pm.value ?? pm._value;
    if (content == null || content === "") {
      const node = pm.querySelector(".ProseMirror, .editor-content");
      if (node) content = node.innerHTML;
    }
    return content ?? "";
  }

  /**
   * Força o commit do editor e lê o conteúdo. Usado APENAS fora do handler
   * "save" (ao trocar de nota ou fechar), por isso pode chamar save().
   */
  #commitAndRead(pm) {
    try {
      pm.save?.();
    } catch (e) {
      console.warn("notex|commitAndRead: pm.save() falhou:", e);
    }
    return this.#readCommitted(pm);
  }

  /** Salva conteúdo numa nota específica (por id), comparando antes para evitar writes à toa. */
  async #saveContentFor(noteId, content) {
    if (!noteId) return;
    const entry = game.journal.get(noteId);
    const page = NotexData.firstPage(entry);
    if (!page) {
      console.warn("notex|saveContentFor: página não encontrada para nota", noteId);
      return;
    }
    if (page.text?.content === content) return;
    await page.update({ "text.content": content });
  }

  /**
   * Salva imediatamente o conteúdo do editor aberto (antes de trocar/fechar).
   * Aqui sim forçamos o commit, pois NÃO estamos dentro do handler "save".
   */
  async #flushActiveEditor() {
    const pm = this.#editorEl;
    const noteId = this.#editorNoteId;
    if (!pm || !noteId) return;
    await this.#saveContentFor(noteId, this.#commitAndRead(pm));
  }

  /* ---- Splitters (rascunho|notas e notas|editor) ---- */
  #wireSplitters(root) {
    root.querySelectorAll(".notex-splitter").forEach((handle) => {
      handle.addEventListener("pointerdown", (ev) => this.#startDragSplit(ev, handle));
    });

    // Aplica larguras salvas.
    const scratch = root.querySelector(".notex-scratch-zone");
    if (scratch) {
      const pct = game.settings.get(MODULE_ID, "scratchWidth") || 38;
      scratch.style.flex = `0 0 ${pct}%`;
    }
    const sidebar = root.querySelector(".notex-sidebar");
    if (sidebar) {
      const pct = game.settings.get(MODULE_ID, "sidebarWidth") || 38;
      sidebar.style.flex = `0 0 ${pct}%`;
    }
  }

  #startDragSplit(ev, handle) {
    ev.preventDefault();
    // A zona a redimensionar é o irmão imediatamente anterior ao splitter.
    const zone = handle.previousElementSibling;
    const container = handle.parentElement;
    if (!zone || !container) return;

    const settingKey =
      handle.dataset.target === "sidebar" ? "sidebarWidth" : "scratchWidth";

    const startX = ev.clientX;
    const startWidth = zone.getBoundingClientRect().width;
    const containerWidth = container.getBoundingClientRect().width;
    const min = containerWidth * 0.12;
    const max = containerWidth * 0.8;

    handle.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    let lastWidth = startWidth;
    const onMove = (e) => {
      lastWidth = Math.min(max, Math.max(min, startWidth + (e.clientX - startX)));
      zone.style.flex = `0 0 ${lastWidth}px`;
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      handle.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const pct = Math.round((lastWidth / containerWidth) * 100);
      game.settings.set(MODULE_ID, settingKey, pct);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /* ---- Drag & Drop ---- */
  #wireDragDrop(root) {
    const dd = new foundry.applications.ux.DragDrop({
      dragSelector: "[draggable='true']",
      dropSelector: ".notex-list",
      callbacks: {
        dragstart: this.#onDragStart.bind(this),
        drop: this.#onDrop.bind(this)
      }
    });
    dd.bind(root);
    this.#dragDrop = [dd];
  }

  #onDragStart(event) {
    const el = event.currentTarget;
    // Pasta sendo arrastada?
    const folderRow = el.closest?.(".notex-folder") ?? (el.classList?.contains("notex-folder-row") ? el.closest(".notex-folder") : null);
    const folderEl = el.classList?.contains("notex-folder-row") ? el.closest(".notex-folder") : null;
    if (folderEl) {
      event.dataTransfer.setData("text/plain", JSON.stringify({ notexFolderId: folderEl.dataset.folderId }));
      return;
    }
    // Nota sendo arrastada.
    const noteEl = el.closest?.(".notex-note[data-uuid]");
    if (!noteEl) return;
    const entry = fromUuidSync(noteEl.dataset.uuid);
    if (!entry) return;
    const data = entry.toDragData();
    data.notexNoteId = entry.id;
    event.dataTransfer.setData("text/plain", JSON.stringify(data));
  }

  async #onDrop(event) {
    if (this.#searchTerm.trim()) return; // sem mover durante busca
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch {
      return;
    }

    // Descobre o destino: pasta sob o cursor, ou a raiz se solto na área vazia.
    const targetFolderEl = event.target.closest(".notex-folder");
    const targetNoteEl = event.target.closest(".notex-note[data-note-id]");
    const root = await NotexData.userRoot();

    // --- Arrastando uma PASTA ---
    if (data.notexFolderId) {
      const folder = game.folders.get(data.notexFolderId);
      if (!folder) return;
      let destId = targetFolderEl?.dataset.folderId ?? root?.id;
      if (destId === folder.id) return; // não pra si mesma
      // Evita mover para dentro de uma descendente (criaria ciclo).
      if (this.#isDescendantFolder(destId, folder.id)) return;
      if (folder.folder?.id !== destId) await folder.update({ folder: destId });
      this.render();
      return;
    }

    // --- Arrastando uma NOTA ---
    const sourceId = data.notexNoteId;
    if (!sourceId) return;
    const source = game.journal.get(sourceId);
    if (!source) return;

    // Solto sobre outra nota → reordena dentro da mesma pasta.
    if (targetNoteEl) {
      const target = game.journal.get(targetNoteEl.dataset.noteId);
      if (target && target.id !== source.id && target.folder?.id === source.folder?.id) {
        const siblings = NotexData.notesInFolder(source.folder).filter((n) => n.id !== source.id);
        const sorter = foundry.utils?.performIntegerSort ?? globalThis.SortingHelpers?.performIntegerSort;
        if (sorter) {
          const updates = sorter(source, { target, siblings, sortKey: "sort" });
          for (const u of updates) await u.target.update({ sort: u.update.sort });
        }
        this.render();
        return;
      }
    }

    // Solto sobre uma pasta (ou área vazia) → move a nota para lá.
    const destId = targetFolderEl?.dataset.folderId ?? root?.id;
    if (destId && source.folder?.id !== destId) {
      await source.update({ folder: destId });
      this.render();
    }
  }

  /** True se candidateId é descendente de folderId (para evitar ciclos). */
  #isDescendantFolder(candidateId, folderId) {
    let f = game.folders.get(candidateId);
    while (f) {
      if (f.id === folderId) return true;
      f = f.folder;
    }
    return false;
  }

  /* ---- Ações ---- */

  static async #onCreateNote() {
    const app = NotexApp.current;
    await app.#flushActiveEditor();
    const note = await NotexData.createNote();
    if (note) {
      app.#activeNoteId = note.id;
      app.#editMode = true; // nota nova já abre pronta para escrever
      app.render();
    }
  }

  static async #onSelectNote(_event, target) {
    const id = target.closest("[data-note-id]")?.dataset.noteId;
    if (!id) return;
    const app = NotexApp.current;
    if (id === app.#activeNoteId && !app.#editMode) return;
    await app.#flushActiveEditor(); // salva a nota atual ANTES de trocar
    app.#activeNoteId = id;
    app.#editMode = false; // nota existente abre em visualização
    app.render();
  }

  /** Lápis: entra em modo edição (na nota clicada ou na ativa). */
  static async #onEditNote(_event, target) {
    const app = NotexApp.current;
    const id = target.closest("[data-note-id]")?.dataset.noteId ?? app.#activeNoteId;
    if (!id) return;
    app.#activeNoteId = id;
    app.#editMode = true;
    app.render();
  }

  /** Botão concluir: salva e volta para visualização. */
  static async #onSaveAndView() {
    const app = NotexApp.current;
    await app.#flushActiveEditor();
    app.#editMode = false;
    app.render();
  }

  static async #onDeleteNote(_event, target) {
    const id = target.closest("[data-note-id]")?.dataset.noteId;
    const note = game.journal.get(id);
    if (!note) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("NOTEX.DeleteTitle") },
      content: game.i18n.format("NOTEX.DeleteConfirm", { name: note.name })
    });
    if (ok) await note.delete();
  }

  /** Cria nota dentro de uma pasta específica (botão na pasta). */
  static async #onCreateNoteHere(_event, target) {
    const app = NotexApp.current;
    const folderId = target.closest("[data-folder-id]")?.dataset.folderId;
    await app.#flushActiveEditor();
    const note = await NotexData.createNote(null, folderId);
    if (note) {
      app.#activeNoteId = note.id;
      app.#editMode = true;
      app.render();
    }
  }

  /** Cria uma pasta na raiz do usuário. */
  static async #onCreateFolder() {
    const name = await NotexApp.#promptName("NOTEX.NewFolder", "NOTEX.NewFolderName");
    if (name === null) return;
    await NotexData.createFolder(name);
    NotexApp.current?.render();
  }

  /** Cria uma subpasta dentro de uma pasta. */
  static async #onCreateFolderHere(_event, target) {
    const parentId = target.closest("[data-folder-id]")?.dataset.folderId;
    const name = await NotexApp.#promptName("NOTEX.NewSubfolder", "NOTEX.NewFolderName");
    if (name === null) return;
    await NotexData.createFolder(name, parentId);
    NotexApp.current?.render();
  }

  /** Exclui uma pasta (e move o conteúdo para a pasta-pai, sem apagar notas). */
  static async #onDeleteFolder(_event, target) {
    const id = target.closest("[data-folder-id]")?.dataset.folderId;
    const folder = game.folders.get(id);
    if (!folder) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("NOTEX.DeleteFolder") },
      content: game.i18n.format("NOTEX.DeleteFolderConfirm", { name: folder.name })
    });
    if (!ok) return;
    // deleteSubfolders/deleteContents = false → conteúdo sobe para a pasta-pai.
    await folder.delete({ deleteSubfolders: false, deleteContents: false });
    NotexApp.current?.render();
  }

  /** Recolhe/expande uma pasta. */
  static #onToggleFolder(_event, target) {
    const id = target.closest("[data-folder-id]")?.dataset.folderId;
    if (!id) return;
    const app = NotexApp.current;
    if (app.#collapsedFolders.has(id)) app.#collapsedFolders.delete(id);
    else app.#collapsedFolders.add(id);
    app.render();
  }

  /** Fixa/desafixa uma nota. */
  static async #onTogglePin(_event, target) {
    const id = target.closest("[data-note-id]")?.dataset.noteId;
    const note = game.journal.get(id);
    if (note) await NotexData.togglePin(note);
  }

  /** Abre um seletor de cor para a nota. */
  static async #onPickColor(_event, target) {
    const id = target.closest("[data-note-id]")?.dataset.noteId;
    const note = game.journal.get(id);
    if (!note) return;
    const current = NotexData.getColor(note);
    const color = await NotexApp.#promptColor(current);
    if (color === undefined) return; // cancelado
    await NotexData.setColor(note, color);
  }

  /* ---- Diálogos auxiliares ---- */

  static async #promptName(titleKey, defaultKey) {
    const def = game.i18n.localize(defaultKey);
    return foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize(titleKey) },
      content: `<input type="text" name="name" value="${def}" autofocus style="width:100%">`,
      ok: {
        label: game.i18n.localize("NOTEX.Create"),
        callback: (_e, button) => button.form.elements.name.value.trim()
      },
      rejectClose: false
    }).catch(() => null);
  }

  static async #promptColor(current) {
    const palette = ["#e03131", "#f08c00", "#f5d90a", "#37b24d", "#1c7ed6", "#7048e8", "#e64980"];
    const swatches = palette
      .map((c) => {
        const sel = c === current ? "selected" : "";
        return `<span class="notex-swatch ${sel}" data-color="${c}" style="background:${c}"></span>`;
      })
      .join("");
    const noneSel = !current ? "selected" : "";
    const content = `<div class="notex-swatches">
      ${swatches}
      <span class="notex-swatch notex-swatch-none ${noneSel}" data-color=""
            data-tooltip="${game.i18n.localize("NOTEX.NoColor")}"><i class="fas fa-ban"></i></span>
    </div>`;

    return new Promise((resolve) => {
      let chosen; // undefined = cancelado
      const dlg = new foundry.applications.api.DialogV2({
        window: { title: game.i18n.localize("NOTEX.Color") },
        content,
        buttons: [
          { action: "cancel", label: game.i18n.localize("Cancel"), callback: () => resolve(undefined) }
        ],
        submit: () => {},
        rejectClose: false
      });
      // Liga os cliques nos swatches após a renderização.
      Hooks.once(`renderDialogV2`, (app, html) => {
        if (app !== dlg) return;
        const root = html instanceof HTMLElement ? html : html[0];
        root.querySelectorAll(".notex-swatch").forEach((s) => {
          s.addEventListener("click", () => {
            chosen = s.dataset.color;
            resolve(chosen);
            dlg.close();
          });
        });
      });
      dlg.render(true);
    });
  }

  static async #onCopyLink(_event, target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    await game.clipboard.copyPlainText(`@UUID[${uuid}]`);
    ui.notifications.info(game.i18n.localize("NOTEX.LinkCopied"));
  }
}

/* -------------------------------------------- */
/*  Atualização ao vivo da lista                 */
/* -------------------------------------------- */

/** Re-renderiza o Notex se a mudança envolveu uma nota do usuário atual. */
function refreshIfMine(entry) {
  const app = NotexApp.current;
  if (!app?.rendered) return;
  if (entry?.getFlag(MODULE_ID, "userId") === game.user.id) app.render();
}

Hooks.on("createJournalEntry", refreshIfMine);
Hooks.on("updateJournalEntry", refreshIfMine);  // pega renomear título ao vivo
Hooks.on("deleteJournalEntry", refreshIfMine);
Hooks.on("createFolder", refreshIfMine);
Hooks.on("updateFolder", refreshIfMine);
Hooks.on("deleteFolder", refreshIfMine);

/* -------------------------------------------- */
/*  Ciclo de vida                                */
/* -------------------------------------------- */

/* -------------------------------------------- */
/*  Idioma por usuário (client-scoped)           */
/* -------------------------------------------- */

const NotexI18n = {
  /** Idiomas suportados: código → rótulo no próprio idioma. */
  LANGUAGES: {
    "pt-BR": "Português (Brasil)",
    "pt-PT": "Português (Portugal)",
    en: "English",
    es: "Español",
    fr: "Français",
    de: "Deutsch",
    it: "Italiano",
    ja: "日本語",
    ko: "한국어",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    ru: "Русский",
    pl: "Polski",
    nl: "Nederlands",
    sv: "Svenska",
    tr: "Türkçe",
    uk: "Українська",
    cs: "Čeština",
    fi: "Suomi",
    "es-MX": "Español (México)",
    ar: "العربية"
  },

  /** Resolve o idioma efetivo: escolha do usuário, ou "auto" → idioma do Foundry. */
  resolve() {
    let choice = "auto";
    try {
      choice = game.settings.get(MODULE_ID, "language") || "auto";
    } catch (e) {
      /* setting ainda não registrada */
    }
    if (choice !== "auto" && this.LANGUAGES[choice]) return choice;

    // Auto: tenta casar o idioma do Foundry; se não houver, cai para inglês.
    const foundryLang = game.i18n?.lang ?? "en";
    if (this.LANGUAGES[foundryLang]) return foundryLang;
    // Tenta o prefixo (ex.: "pt" de "pt-BR" → primeiro "pt-*" disponível).
    const prefix = foundryLang.split("-")[0];
    const match = Object.keys(this.LANGUAGES).find((c) => c.startsWith(prefix));
    return match ?? "en";
  },

  /** Carrega o JSON do idioma e sobrescreve as chaves NOTEX.* localmente. */
  async apply() {
    const lang = this.resolve();
    try {
      const path = `modules/${MODULE_ID}/lang/${lang}.json`;
      const data = await foundry.utils.fetchJsonWithTimeout(path);
      // Mescla apenas as chaves do Notex no dicionário ativo deste cliente.
      for (const [key, value] of Object.entries(data)) {
        foundry.utils.setProperty(game.i18n.translations, key, value);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | falha ao carregar idioma ${lang}:`, e);
    }
  }
};

Hooks.once("init", () => {
  // Partials recursivos para renderizar a árvore de pastas/notas.
  const note = `
<div class="notex-node notex-note {{#if active}}active{{/if}} {{#if pinned}}is-pinned{{/if}}"
     data-note-id="{{id}}" data-uuid="{{uuid}}" draggable="true"
     style="{{#if color}}--notex-note-color: {{color}};{{/if}}">
  <span class="notex-note-dot"></span>
  <a class="notex-note-open" data-action="selectNote">
    <span class="notex-note-name">{{name}}</span>
  </a>
  <a class="notex-note-pin {{#if pinned}}active{{/if}}" data-action="togglePin"
     data-tooltip="{{localize 'NOTEX.Pin'}}"><i class="fas fa-thumbtack"></i></a>
  <a class="notex-note-color" data-action="pickColor"
     data-tooltip="{{localize 'NOTEX.Color'}}"><i class="fas fa-palette"></i></a>
  <a class="notex-note-edit" data-action="editNote"
     data-tooltip="{{localize 'NOTEX.Edit'}}"><i class="fas fa-pen"></i></a>
  <a class="notex-note-copy" data-action="copyLink"
     data-tooltip="{{localize 'NOTEX.CopyLink'}}"><i class="fas fa-link"></i></a>
  <a class="notex-note-delete" data-action="deleteNote"
     data-tooltip="{{localize 'NOTEX.Delete'}}"><i class="fas fa-trash"></i></a>
</div>`;

  const folder = `
<div class="notex-node notex-folder {{#if collapsed}}collapsed{{/if}}" data-folder-id="{{id}}">
  <div class="notex-folder-row" draggable="true">
    <a class="notex-folder-toggle" data-action="toggleFolder">
      <i class="fas {{#if collapsed}}fa-folder{{else}}fa-folder-open{{/if}}"></i>
    </a>
    <span class="notex-folder-name" data-action="toggleFolder">{{name}}</span>
    <a class="notex-folder-add-note" data-action="createNoteHere"
       data-tooltip="{{localize 'NOTEX.NewNoteHere'}}"><i class="fas fa-file-circle-plus"></i></a>
    <a class="notex-folder-add" data-action="createFolderHere"
       data-tooltip="{{localize 'NOTEX.NewSubfolder'}}"><i class="fas fa-folder-plus"></i></a>
    <a class="notex-folder-delete" data-action="deleteFolder"
       data-tooltip="{{localize 'NOTEX.DeleteFolder'}}"><i class="fas fa-trash"></i></a>
  </div>
  {{#unless collapsed}}
  <div class="notex-folder-children">
    {{#each children}}
      {{#if (eq this.type "folder")}}{{> notexFolder}}{{else}}{{> notexNote}}{{/if}}
    {{/each}}
  </div>
  {{/unless}}
</div>`;

  Handlebars.registerPartial("notexNote", note);
  Handlebars.registerPartial("notexFolder", folder);
  Handlebars.registerHelper("eq", (a, b) => a === b);

  game.settings.register(MODULE_ID, "language", {
    name: "NOTEX.Settings.Language",
    hint: "NOTEX.Settings.LanguageHint",
    scope: "client", // pessoal: só afeta este usuário
    config: true,
    type: String,
    default: "auto",
    choices: { auto: "NOTEX.Settings.LanguageAuto", ...NotexI18n.LANGUAGES },
    onChange: async () => {
      await NotexI18n.apply();
      NotexApp.current?.render();
      ui.players?.render();
    }
  });

  // Largura da zona de rascunho (em %). Oculta da config; salva pelo drag.
  game.settings.register(MODULE_ID, "scratchWidth", {
    scope: "client",
    config: false,
    type: Number,
    default: 38
  });

  // Largura da lista de notas (em %). Oculta da config; salva pelo drag.
  game.settings.register(MODULE_ID, "sidebarWidth", {
    scope: "client",
    config: false,
    type: Number,
    default: 38
  });
});

Hooks.once("ready", async () => {
  await NotexI18n.apply(); // aplica o idioma do usuário antes de qualquer UI
  if (game.user.isGM) await NotexFolders.ensureRoot();
  const mod = game.modules.get(MODULE_ID);
  mod.api = { folders: NotexFolders, data: NotexData, i18n: NotexI18n, open: () => NotexApp.open() };
});

/* -------------------------------------------- */
/*  Botão na barra de controles (sidebar)        */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  const tokens = controls.tokens;
  if (!tokens?.tools) return;
  tokens.tools.notex = {
    name: "notex",
    title: "NOTEX.OpenTooltip",
    icon: "fas fa-note-sticky",
    order: Object.keys(tokens.tools).length,
    button: true, // dispara ação, não vira modo de camada
    onChange: () => NotexApp.open()
  };
});

/* -------------------------------------------- */
/*  Botão na lista de jogadores                  */
/* -------------------------------------------- */

Hooks.on("renderPlayers", (_app, html, _context) => {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  const ownRow = root.querySelector(`[data-user-id="${game.user.id}"]`);
  if (!ownRow || ownRow.querySelector(".notex-open-btn")) return;

  const btn = document.createElement("a");
  btn.className = "notex-open-btn";
  btn.dataset.tooltip = game.i18n.localize("NOTEX.OpenTooltip");
  btn.innerHTML = '<i class="fas fa-note-sticky"></i>';
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    NotexApp.open();
  });
  ownRow.appendChild(btn);
});
