/* Grids: blocks next to each other, a picture beside its text (docs/DESIGN.md
   §2, Grids).

   A grid's children are cells, filled row by row in position order, and a
   cell's children are ordinary blocks. So most of the editor needs nothing
   new: a cell's blocks render, type, nest, sync and undo like any others, and
   the rules that keep a grid a grid live with the structural edits in
   app.editor.js. What is here is what a grid adds:

   * the renderers: the grid is a CSS grid around its children container,
     with a "+" strip for another column and one for another row; a cell is a
     container that says so when it is empty, with a menu for rows and columns;
   * row and column edits, made as whole rows, so a new column lands at the
     same place in every row;
   * geometry for the parts of the editor that think in a single column of
     rows (the gutter, drops): cellAt() finds the cell under the pointer, and
     inside it they work as they do on the page, with each grid in a list
     counting as one block (visibleIn). */

(() => {
  const E = App.editor;
  const { h, types, colorClass } = E;
  const P = E.Editor.prototype;

  const MAX_COLUMNS = 6;
  const columnsOf = (b) => App.mdblocks.gridColumns(b && b.props);

  function setColumns(el, b) {
    const n = columnsOf(b);
    el.style.setProperty("--grid-cols", String(n));
    el.classList.toggle("is-full", n >= MAX_COLUMNS);
  }

  function addStrip(cls, title, onClick) {
    const bt = h("button", `grid-add ${cls}`);
    bt.type = "button";
    bt.title = title;
    bt.setAttribute("aria-label", title);
    bt.innerHTML = App.icon("plus", 14);
    bt.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    bt.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return bt;
  }

  // --- renderers ------------------------------------------------------------------
  types.grid = {
    render(ed, el, b) {
      setColumns(el, b);
      const row = h("div", "grid-frame");
      const main = h("div", "grid-main");
      const body = h("div", "grid-body");
      main.append(body);
      row.append(main);
      if (!ed.readOnly) {
        main.append(addStrip("grid-add-col", "Add a column", () => ed.gridEdit(el.dataset.id, "col-end")));
        row.append(addStrip("grid-add-row", "Add a row", () => ed.gridEdit(el.dataset.id, "row-end")));
      }
      // Enter on the selected grid: into its first line.
      el._activate = () => {
        const first = [...el.querySelectorAll(".blk")].find((x) => ed.isTextTarget(x));
        if (first) ed.focusBlock(first.dataset.id, "start");
      };
      return { row, kidsHost: body };
    },
    // A new column count restyles the grid where it is. A new colour is a
    // new class list, which fill() writes, so that rebuilds.
    update(ed, el, b) {
      const before = JSON.parse(el._b.props || "{}");
      if (colorClass(before) !== colorClass(b.props)) return false;
      setColumns(el, b);
      return true;
    },
  };

  types.grid_cell = {
    render(ed, el) {
      const row = h("div", "cell-frame");
      if (!ed.readOnly) {
        const btn = h("button", "cell-menu-btn");
        btn.type = "button";
        btn.title = "Rows and columns";
        btn.setAttribute("aria-label", "Rows and columns");
        btn.innerHTML = App.icon("dots", 14);
        btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("click", (e) => { e.stopPropagation(); ed.gridCellMenu(el, btn); });
        row.append(btn);
      }
      // The children go in after the button; an empty cell's hint is CSS.
      return { row, kidsHost: row };
    },
  };

  // --- the grid as rows --------------------------------------------------------------
  /* Child ids in rows of `cols`, the last row short when the cells run out.
     Every child takes a slot, a cell or not, as the renderer gives it one. */
  P.gridShape = function (gridId) {
    const cols = columnsOf(App.store.block(gridId));
    const ids = App.store.childBlocks(gridId).filter((b) => b.page_id === this.pageId).map((b) => b.id);
    const rows = [];
    for (let k = 0; k < ids.length; k += cols) rows.push(ids.slice(k, k + cols));
    return { cols, rows };
  };

  // Where a cell element sits in its grid.
  P.cellPos = function (cellEl) {
    const b = App.store.block(cellEl.dataset.id);
    if (!b || !b.parent_id) return null;
    const { cols, rows } = this.gridShape(b.parent_id);
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(b.id);
      if (c >= 0) return { gridId: b.parent_id, r, c, cols, rows: rows.length };
    }
    return null;
  };

  // A new cell, with an empty line to type in. Inside op().
  P.newCell = function (gridId, placement = {}) {
    const cell = this.create({ parentId: gridId, ...placement, type: "grid_cell" });
    this.create({ parentId: cell.id, type: "paragraph" });
    return cell;
  };

  // How many blocks with something in them a cell holds.
  function contentOf(cellId) {
    const blank = (x) => x.type === "paragraph" && !x.text && !App.store.childBlocks(x.id).length;
    return App.store.childBlocks(cellId).filter((x) => !blank(x)).length;
  }

  /* Row and column edits. `at` ({ r, c }) is the cell an edit is relative
     to; the "+" strips add at the end. The last row is filled out first, so
     the grid is whole rows and a column lands at the same place in each.
     Taking the only column or row away takes the grid. */
  P.gridEdit = function (gridId, action, at = null) {
    if (this.readOnly) return;
    const g = App.store.block(gridId);
    if (!g || g.deleted) return;
    const shape = this.gridShape(gridId);
    const addCol = action === "col-left" || action === "col-right" || action === "col-end";
    if (addCol && shape.cols >= MAX_COLUMNS && shape.rows.length) {
      App.toast(`A grid has at most ${MAX_COLUMNS} columns`);
      return;
    }
    if ((action === "col-delete" && shape.cols <= 1) || (action === "row-delete" && shape.rows.length <= 1)) {
      this.deleteBlocks([gridId]);
      return;
    }
    let land = null;   // the cell whose first line gets the caret
    let lost = 0;      // blocks with content deleted along with their cells
    const labels = { "col-delete": "Delete column", "row-delete": "Delete row" };
    this.op(labels[action] || (addCol ? "Add column" : "Add row"), () => {
      const { cols, rows } = this.gridShape(gridId);
      const last = rows[rows.length - 1];
      if (last && last.length < cols) {
        while (last.length < cols) last.push(this.newCell(gridId, { after: last[last.length - 1] }).id);
      }
      const props = { ...(App.store.block(gridId).props || {}) };
      if (addCol && rows.length) {
        const j = action === "col-end" ? cols : action === "col-left" ? at.c : at.c + 1;
        rows.forEach((row, r) => {
          const cell = this.newCell(gridId, j < cols ? { before: row[j] } : { after: row[cols - 1] });
          if (r === (at ? at.r : 0)) land = cell.id;
        });
        this.update(gridId, { props: { ...props, columns: cols + 1 } });
      } else if (addCol || action === "row-above" || action === "row-below" || action === "row-end") {
        // (A grid with no cells at all gets its first row either way.)
        const i = action === "row-above" ? at.r : action === "row-below" ? at.r + 1 : rows.length;
        let place = i < rows.length ? { before: rows[i][0] } : {};
        for (let k = 0; k < cols; k++) {
          const cell = this.newCell(gridId, place);
          if (!k || (at && k === at.c)) land = cell.id;
          place = { after: cell.id };
        }
      } else if (action === "col-delete") {
        for (const row of rows) { lost += contentOf(row[at.c]); this.remove(row[at.c]); }
        this.update(gridId, { props: { ...props, columns: cols - 1 } });
      } else if (action === "row-delete") {
        for (const id of rows[at.r]) { lost += contentOf(id); this.remove(id); }
      }
    });
    if (land) {
      const first = App.store.childBlocks(land)[0];
      if (first) this.focusBlock(first.id, "start");
    } else if (this.els.has(gridId)) {
      this.selectBlocks([gridId]);
    }
    if (lost) {
      App.toast(action === "col-delete" ? "Column deleted" : "Row deleted", { action: { label: "Undo", run: () => this.undo(false) } });
    }
  };

  P.gridCellMenu = function (cellEl, anchor) {
    const pos = this.cellPos(cellEl);
    if (!pos || this.readOnly) return;
    const act = (a) => () => this.gridEdit(pos.gridId, a, pos);
    const full = pos.cols >= MAX_COLUMNS;
    this.menu = App.ui.menu(anchor, [
      { label: "Insert column left", icon: "plus", disabled: full, onSelect: act("col-left") },
      { label: "Insert column right", icon: "plus", disabled: full, onSelect: act("col-right") },
      { label: "Insert row above", icon: "plus", onSelect: act("row-above") },
      { label: "Insert row below", icon: "plus", onSelect: act("row-below") },
      { divider: true },
      { label: "Delete column", icon: "trash", danger: true, onSelect: act("col-delete") },
      { label: "Delete row", icon: "trash", danger: true, onSelect: act("row-delete") },
    ], { className: "cell-menu" });
  };

  // The grid's own block menu (its drag handle) adds at the end.
  P.gridMenuItems = function (gridId) {
    const { cols } = this.gridShape(gridId);
    return [
      { label: "Add column", icon: "columns", disabled: cols >= MAX_COLUMNS, onSelect: () => this.gridEdit(gridId, "col-end") },
      { label: "Add row", icon: "grid", onSelect: () => this.gridEdit(gridId, "row-end") },
    ];
  };

  // --- writing in a cell ---------------------------------------------------------------
  /* A press on a cell's empty space (below its blocks, or all of an empty
     cell): into its last line when that is empty, else a new one. The cell's
     own focusTrailing(). */
  P.focusCellEnd = function (cellEl) {
    this.flushAll();
    const id = cellEl.dataset.id;
    const kids = App.store.childBlocks(id);
    const last = kids[kids.length - 1];
    if (last && last.type === "paragraph" && !last.text && !App.store.childBlocks(last.id).length) {
      this.focusBlock(last.id, "start");
      return;
    }
    if (this.readOnly) return;
    const b = this.op("New block", () => this.create({ parentId: id, type: "paragraph" }));
    if (b) this.focusBlock(b.id, "start");
  };

  /* The empty line a new cell starts with, when that is all the cell holds
     besides `incoming`: blocks dropped into the cell take its place. */
  P.placeholderLine = function (cellId, incoming = []) {
    const cell = cellId && App.store.block(cellId);
    if (!cell || cell.type !== "grid_cell") return null;
    const rest = App.store.childBlocks(cellId).filter((x) => !incoming.includes(x.id));
    const only = rest.length === 1 ? rest[0] : null;
    return only && only.type === "paragraph" && !only.text && !App.store.childBlocks(only.id).length ? only.id : null;
  };

  // --- geometry -------------------------------------------------------------------------
  /* Blocks in reading order inside a container (the page, or a cell's
     children), as visibleBlocks() does for the page, except that a grid is
     one block: its cells sit side by side, so their rows are not one list. */
  P.visibleIn = function (container) {
    const out = [];
    const walk = (c) => {
      for (let x = c.firstElementChild; x; x = x.nextElementSibling) {
        if (!x.dataset.id) continue;
        out.push(x);
        if (x._kids && !this.collapsed(x) && x._b.type !== "grid") walk(x._kids);
      }
    };
    walk(container);
    return out;
  };

  /* The cell a point is in, for the gutter and for drops, or null. A grid
     counts over the height of its cells, from the page's left margin to its
     right one, so a pointer beside a grid finds the cell next to it; within a
     cell, a grid inside counts the same way. Of a grid's cells, the one
     nearest the point is it (the gaps between cells belong to a neighbour).
     Grids inside `exclude` (blocks being dragged) do not count. */
  P.cellAt = function (x, y, exclude = null) {
    const grids = [...this.blocksEl.querySelectorAll(".blk-grid")]
      .filter((g) => g._kids && !(exclude && exclude.some((d) => d === g || d.contains(g))));
    let cell = null;
    for (;;) {
      const grid = grids.find((g) => {
        if (this.enclosingCell(g) !== cell) return false;
        const r = g._kids.getBoundingClientRect();
        return r.height > 0 && y >= r.top && y <= r.bottom;
      });
      if (!grid) return cell;
      let best = null;
      let bestD = Infinity;
      for (let c = grid._kids.firstElementChild; c; c = c.nextElementSibling) {
        if (!c.dataset.id || c._b.type !== "grid_cell") continue;
        const r = c.getBoundingClientRect();
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestD) { best = c; bestD = d; }
      }
      if (!best) return cell;
      cell = best;
    }
  };
})();
