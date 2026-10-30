import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { exec, theme, spaces, props, appHome, readTextFile, settings, shared, setShared } from "herdr";
import { placeOf } from "./place.js";
import { groups, addRecent, recentHere, looksLikePath } from "./files.js";

// Shows an HTML or Markdown file as the page Chrome draws, or its source, on the
// machine of this pane's own space: render.mjs runs there, keeps one Chrome open,
// and sends the page back in tiles, the first one as soon as it is laid out.
// Props: { space?, file?, machine?, view?: "page" | "code" }. Without a file it shows a search, recent files
// and the space's .html and .md files by folder.
const NAME = "html-viewer";
// Hidden: the app reloads a mod when a visible file in its folder changes.
const CACHE = `mods/${NAME}/.cache`;
const icon = (name) => `mods/${NAME}/${name}.svg`;
const RECENT = `${NAME}.recent`;
const POLL_MS = 2000;
const REFLOW_PX = 40;
// Rows drawn on the start screen: every row costs render time, which is capped.
const MAX_ROWS = 80;

let worker = null;
const source = async () => (worker ??= await readTextFile(`${appHome()}/mods/${NAME}/render.mjs`));
function parse(r) {
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { throw new Error(r.stderr.trim() || `node exited with ${r.code}`); }
}
async function call(machine, ...args) {
  const res = parse(await exec("node", ["--input-type=module", "-e", await source(), "herdr-html", ...args], { on: machine }));
  if (!res.ok) throw new Error(res.error);
  return res;
}

// From another machine a PNG comes raw through hc exec, which keeps bytes intact;
// `show` sends its JSON line first.
const REMOTE = `m=$1; src=$2; out=$3; shift 3
hc exec --on "$m" node --input-type=module -e "$src" herdr-html "$@" - > "$out.part"
if [ "$1" = show ]; then { IFS= read -r meta; printf '%s\\n' "$meta"; cat > "$out"; } < "$out.part"
elif [ "$(head -c 4 "$out.part" | tail -c 3)" = PNG ]; then mv "$out.part" "$out"; echo '{"ok":true}'
else cat "$out.part"; fi
rm -f "$out.part"`;
async function png(machine, out, ...args) {
  await exec("mkdir", ["-p", out.slice(0, out.lastIndexOf("/"))]);
  if (!machine) return call(null, ...args, out);
  const res = parse(await exec("sh", ["-c", REMOTE, "sh", machine, await source(), out, ...args]));
  if (!res.ok) throw new Error(res.error);
  return res;
}

// Viewer copies per machine: the last one to close stops that machine's Chrome
// (it would also stop by itself after a few idle minutes).
const users = new Map();

export default class HtmlViewer extends View {
  init(_p, cx) {
    const p = props() ?? {};
    Object.assign(this, placeOf(p, spaces()));
    this.file = null; this.kind = null; this.mtime = 0;
    this.meta = null; this.tiles = []; this.drawn = null; this.took = null;
    this.mode = "page"; this.code = null; this.codeError = null;
    this.files = null; this.listed = null; this.listError = null;
    this.error = null; this.busy = false; this.width = 0;
    this.input = InputState.new({ placeholder: "Search files, or paste a path" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.submit(cx));
    users.set(this.machine, (users.get(this.machine) ?? 0) + 1);
    // Pictures left by copies that never closed.
    exec("find", [`${appHome()}/${CACHE}`, "-mindepth", "1", "-maxdepth", "1", "-mmin", "+1440", "-exec", "rm", "-rf", "{}", "+"]).catch(() => {});
    if (p.file) this.open(p.file, cx, p.view === "code" ? "code" : "page");
    else this.list(cx);
    cx.timer.every(POLL_MS, (cx) => this.watch(cx));
  }

  async close() {
    this.code?.release();
    const left = (users.get(this.machine) ?? 1) - 1;
    users.set(this.machine, left);
    if (left === 0) await call(this.machine, "stop").catch(() => {});
  }

  where() { return this.machine ?? "This Mac"; }

  // The pane's size comes in screen points, but lengths in styles get the app's zoom on top.
  pageWidth() { return (this.width || 900) / (settings().zoom || 1); }

  list(cx) {
    this.listError = null;
    cx.spawn(async (cx) => {
      try {
        const r = await call(this.machine, "list", this.folder ?? "");
        this.files = r.files; this.listed = r.folder;
      } catch (e) {
        this.files = []; this.listError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  submit(cx) {
    const typed = this.input.value().trim();
    if (!typed) return;
    const first = recentHere(shared(RECENT), this.machine, typed)[0] ?? groups(this.files ?? [], this.listed, typed)[0]?.files[0];
    this.open(looksLikePath(typed) || !first ? typed : first.path, cx);
  }

  open(input, cx, mode = "page") {
    this.error = null; this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await call(this.machine, "resolve", String(input), this.folder ?? "");
        this.forget();
        this.file = r.path; this.kind = r.kind; this.mtime = r.mtime; this.mode = mode;
        setShared(RECENT, addRecent(shared(RECENT), { machine: this.machine, path: r.path }));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      if (this.file && this.mode === "code") this.loadCode(cx);
      if (this.file) await this.draw(cx); else cx.notify();
    });
  }

  back(cx) {
    this.forget(); this.file = null; this.error = null; this.input.set_value("");
    this.list(cx);
    cx.notify();
  }

  // Drops this copy's picture and source view.
  forget() {
    this.dropPicture();
    this.code?.release(); this.code = null; this.codeError = null;
  }

  dropPicture() {
    if (this.drawn) exec("rm", ["-rf", `${appHome()}/${this.drawn}`]).catch(() => {});
    this.drawn = null; this.meta = null; this.tiles = [];
  }

  // Redraw when the file changed on its machine, or the pane got wider or narrower.
  async watch(cx) {
    if (!this.file || this.busy) return;
    const { mtime } = await call(this.machine, "stat", this.file).catch(() => ({ mtime: this.mtime }));
    const changed = mtime !== this.mtime, reflow = this.meta && this.width && Math.abs(this.pageWidth() - this.meta.width) > REFLOW_PX;
    if (changed) {
      this.mtime = mtime; this.code?.release(); this.code = null;
      if (this.mode === "code") this.loadCode(cx);
    }
    if (changed || reflow || !this.meta) await this.draw(cx);
  }

  async draw(cx) {
    if (this.busy || !this.file) return;
    this.busy = true; cx.notify();
    const file = this.file, width = Math.round(this.pageWidth()), started = Date.now();
    const dir = `${CACHE}/${this.machine ?? "here"}-${started.toString(36)}`;
    try {
      const meta = await png(this.machine, `${appHome()}/${dir}/0.png`, "show", file, String(width));
      if (this.file !== file) return;
      this.dropPicture();
      this.meta = meta; this.drawn = dir; this.tiles = [`${dir}/0.png`]; this.took = Date.now() - started; this.error = null;
      this.busy = false; cx.notify();
      for (let n = 1; n < meta.tiles.length && this.drawn === dir; n++) {
        await png(this.machine, `${appHome()}/${dir}/${n}.png`, "tile", meta.key, String(n));
        if (this.drawn !== dir) return;
        this.tiles[n] = `${dir}/${n}.png`;
        cx.notify();
      }
    } catch (e) {
      if (this.file === file) this.error = String(e?.message ?? e);
    } finally {
      if (this.drawn === dir || !this.meta) this.busy = false;
      cx.notify();
    }
  }

  setMode(mode, cx) {
    this.mode = mode;
    if (mode === "code" && !this.code) this.loadCode(cx);
    cx.notify();
  }

  loadCode(cx) {
    const file = this.file;
    this.codeError = null;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on: this.machine });
        if (this.file !== file) return;
        if (text === null) throw new Error(`No such file: ${file}`);
        const t = theme();
        this.code?.release();
        this.code = EditorState.new({
          language: this.kind === "markdown" ? "markdown" : "html", readonly: true, value: text,
          font_family: settings().font_family, font_size: 12, soft_wrap: this.kind === "markdown",
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, punctuation: t.muted },
        });
      } catch (e) {
        this.codeError = `Cannot show the source: ${e?.message ?? e} (files over 1 MiB can't be read)`;
      }
      cx.notify();
    });
  }

  machineChip(t) {
    return h_flex().flex_none().gap(5).px(7).py(2).rounded(6).border_1().border_color(t.border).items_center().text_size(11).text_color(t.muted)
      .child(svg(icon(this.machine ? "server" : "monitor")).size(12).text_color(t.dim))
      .child(this.where());
  }

  spinner(t) {
    return svg(icon("spinner")).size(13).flex_none().text_color(t.working).spin(900);
  }

  segmented(t) {
    return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised).border_1().border_color(t.border)
      .children([["page", "Page"], ["code", "Code"]].map(([id, label]) =>
        div().id(`hv-mode-${id}`).px(9).py(2).rounded(5).text_size(11.5).cursor_pointer()
          .when(this.mode === id, (e) => e.bg(t.background).font_semibold())
          .text_color(this.mode === id ? t.foreground : t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.setMode(id, cx))
          .child(label)));
  }

  header(t) {
    const cut = this.file.lastIndexOf("/");
    const loaded = this.tiles.filter(Boolean).length, total = this.meta?.tiles.length ?? 0;
    const status = this.busy || (this.meta && loaded < total)
      ? h_flex().gap(6).items_center().child(this.spinner(t)).when(total > 1, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${loaded}/${total}`)))
      : this.error ? div().size(7).rounded(4).bg(t.blocked)
      : div().text_size(11).text_color(t.dim).child(this.took == null ? "" : `${(this.took / 1000).toFixed(1)} s`);
    return h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().id("hv-back").flex_none().p(3).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.back(cx))
        .child(svg(icon("back")).size(14).text_color(t.muted)))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_none().max_w(360).truncate().font_semibold().child(this.file.slice(cut + 1)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.file.slice(0, cut))))
      .when(Boolean(this.meta?.mermaid), (e) => e.child(div().flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(`${this.meta.mermaid} mermaid`)))
      .child(this.machineChip(t))
      .child(this.segmented(t))
      .child(h_flex().w(44).flex_none().justify_end().child(status));
  }

  page(t) {
    if (!this.meta) {
      return v_flex().flex_1().items_center().justify_center().gap(10).text_color(this.error ? t.blocked : t.dim)
        .when(!this.error, (e) => e.child(this.spinner(t)))
        .child(div().max_w(520).text_center().child(this.error ?? `Drawing the page on ${this.where()}…`));
    }
    const m = this.meta;
    return v_flex().id("hv-page").flex_1().min_h(0).overflow_y_scrollbar().bg("#ffffff")
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(6).text_size(11.5).bg(t.background).text_color(t.blocked).child(`Could not update: ${this.error}`)))
      .children(m.tiles.map((tile, n) => this.tiles[n] ? image(this.tiles[n]).w(m.width).h(tile.h).flex_none() : div().w(m.width).h(tile.h).flex_none()))
      .when(m.clipped, (el) => el.child(div().p(8).text_size(11.5).text_color("#666666").child("The page is cut at 60 000 px.")));
  }

  sourceView(t) {
    if (this.code) return Editor.new(this.code).flex_1().min_h(0);
    return v_flex().flex_1().items_center().justify_center().gap(10).text_color(this.codeError ? t.blocked : t.dim)
      .when(!this.codeError, (e) => e.child(this.spinner(t)))
      .child(this.codeError ?? "Reading the source…");
  }

  row(t, id, glyph, name, detail, path) {
    return h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(path, cx))
      .child(svg(icon(glyph)).size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(320).truncate().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(detail));
  }

  section(t, title) {
    return div().px(8).pt(12).pb(4).text_size(11.5).font_medium().text_color(t.dim).truncate().child(title);
  }

  start(t) {
    const typed = this.input.value();
    const recent = recentHere(shared(RECENT), this.machine, typed);
    const found = groups(this.files ?? [], this.listed, typed);
    const kind = (name) => (/\.(md|markdown|mdown)$/i.test(name) ? "markdown" : "file");
    const rows = [];
    if (recent.length) {
      rows.push(this.section(t, "Recent"));
      for (const r of recent) rows.push(this.row(t, `hv-recent-${r.path}`, kind(r.name), r.name, r.dir, r.path));
    }
    let shown = 0, hidden = 0;
    for (const g of found) {
      if (shown >= MAX_ROWS) { hidden += g.files.length; continue; }
      rows.push(this.section(t, g.folder ? `${g.folder}/` : (this.listed?.split("/").pop() || "/")));
      for (const f of g.files) {
        if (shown++ >= MAX_ROWS) { hidden++; continue; }
        rows.push(this.row(t, `hv-file-${f.path}`, kind(f.name), f.name, "", f.path));
      }
    }
    const state = (glyph, text, color) => h_flex().px(8).py(14).gap(8).items_center().text_color(color)
      .when(Boolean(glyph), (e) => e.child(glyph)).child(div().flex_1().min_w(0).child(text));
    const folder = this.listed ?? this.folder ?? "home";
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("HTML viewer"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(folder))
        .child(this.machineChip(t)))
      .child(v_flex().flex_none().px(12).pt(12).gap(8)
        .child(h_flex().h(36).px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(svg(icon("search")).size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
        .when(Boolean(this.error), (e) => e.child(div().px(2).text_size(12).text_color(t.blocked).child(this.error)))
        .when(this.busy, (e) => e.child(h_flex().px(2).gap(8).items_center().text_size(12).text_color(t.dim).child(this.spinner(t)).child("Opening…"))))
      .child(v_flex().id("hv-files").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(10)
        .children(rows)
        .when(this.files === null, (e) => e.child(state(this.spinner(t), `Looking for .html and .md files in ${folder}…`, t.dim)))
        .when(Boolean(this.listError), (e) => e.child(state(null, `Could not list ${folder}: ${this.listError}`, t.blocked))
          .child(div().id("hv-retry").mx(8).px(10).py(4).rounded(7).border_1().border_color(t.border).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.files = null; this.list(cx); cx.notify(); }).child("Try again")))
        .when(this.files !== null && !this.listError && !this.files.length && !recent.length, (e) => e.child(state(null, `No .html or .md files under ${folder}. Paste a path above.`, t.dim)))
        .when(Boolean(typed.trim()) && !found.length && !recent.length && Boolean(this.files?.length), (e) => e.child(state(null, "No file matches. Enter opens it as a path.", t.dim)))
        .when(hidden > 0, (e) => e.child(div().px(8).py(8).text_size(11.5).text_color(t.dim).child(`${hidden} more: type to narrow the list`))));
  }

  render() {
    const t = theme();
    return v_flex().id("root").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.width = size.width; if (!this.meta) cx.notify(); })
      .when(Boolean(this.file), (el) => el.child(this.header(t)).child(this.mode === "code" ? this.sourceView(t) : this.page(t)))
      .when(!this.file, (el) => el.child(this.start(t)));
  }
}
