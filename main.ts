import { App, Editor, MarkdownPostProcessorContext, MarkdownRenderer, Modal, Notice, Plugin } from "obsidian";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { Range, Text } from "@codemirror/state";

export default class SafeLearnPlugin extends Plugin {
  async onload() {
    console.log("✅ SafeLearn plugin loaded");

    this.registerEditorExtension(safelearnHighlighter);
    this.registerMarkdownPostProcessor((el, ctx) => hideTags(el, ctx, this));

    // The palette and the context menu are built from one list. Two lists would
    // be free to disagree, and the way that shows is a command present in one
    // and missing from the other - which reads as the menu being broken rather
    // than as an entry having been forgotten.
    for (const command of AUTHORING_COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        editorCallback: (editor) => command.run(editor, this),
      });
    }
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        for (const command of AUTHORING_COMMANDS) {
          menu.addItem((item) =>
            item
              .setTitle(command.name)
              // The menu belongs to Obsidian and other plugins fill it too. A
              // section of its own keeps these entries together without any of
              // them being moved.
              .setSection(MENU_SECTION)
              .onClick(() => command.run(editor, this))
          );
        }
      })
    );
  }
}

// ################### What counts as a tag ###################

/**
 * The rules below are the renderer's rules, not this plugin's.
 *
 * The plugin enforces nothing. Its whole value is that a person writing a
 * document can see what the server will do with it before publishing - so where
 * the two disagree the marking does not merely mislead about a detail, it
 * misleads about the only thing it is for. Each rule here is written as
 * `obsidian.js` writes it, and there is one of each, used by the editor and by
 * the rendered view alike: two rules for one tag form in one plugin is what let
 * the two halves drift apart in opposite directions.
 *
 * Every rule is returned from a function rather than kept in a constant. A
 * global regular expression remembers where it last stopped, so a shared one
 * asked twice whether it matches answers differently the second time.
 */

const FRAGMENT = "##fragment";
const SIDE_BY_SIDE_START = "##side-by-side-start";
const SIDE_BY_SIDE_END = "##side-by-side-end";
const SEPARATOR = "##separator";

/** `preprocessFragments`: case-sensitive, anywhere in the line, every occurrence, wherever whitespace or the end follows. */
function fragmentPattern(): RegExp {
  return /##fragment(?=\s|$)/g;
}

/** `preprocessSideBySide`: the three markers, case-sensitive, as plain substrings. */
function blockMarkerPattern(): RegExp {
  return /##(?:side-by-side-(?:start|end)|separator)/g;
}

/** `inlinePermissionRegex`: a line that is `@@@`, with or without the roles it names. */
function permissionMarkerPattern(): RegExp {
  return /^[ \t]*@@@.*$/gm;
}

/**
 * Every `##fragment` in a line, each with the extent of what actually matched.
 *
 * The extent comes from the match and never from an assumed spelling of the tag:
 * a length computed from `"##fragment "` is one character too long for the same
 * tag at the end of a line, and reaches into the line after it.
 */
function fragmentsIn(text: string): { index: number; length: number }[] {
  const found: { index: number; length: number }[] = [];
  const pattern = fragmentPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ index: match.index, length: match[0].length });
  }
  return found;
}

/**
 * Whether a line is nothing but the given block marker.
 *
 * This is a deliberate divergence from the renderer, which would accept the
 * marker in the middle of a sentence: a block whose boundary sits inside running
 * text has no sensible marking to draw around it. It only applies to documents
 * nobody writes, but it is a divergence, and it is recorded as an observation in
 * `AI/architecture.md` rather than left to be found as a bug.
 */
function isMarkerLine(text: string, marker: string): boolean {
  return text.trim() === marker;
}

/** A first line beginning with `@@@` gates the whole file; see `resolveBlocks`. */
function isFileLevelDirective(text: string): boolean {
  return /^[ \t]*@@@/.test(text);
}

/** An opening marker names what it gates. One that names nothing opens nothing. */
function opensPermissionBlock(text: string): boolean {
  return /^[ \t]*@@@[ \t]*\S/.test(text);
}

/** A closing marker names nothing - which is also why it cannot be an opening one. */
function closesPermissionBlock(text: string): boolean {
  return /^[ \t]*@@@[ \t]*$/.test(text);
}

/** `parseFirstLineForPermissions` and `inlinePermissionRegex`: what a directive line opens with. */
function directiveOpeningPattern(): RegExp {
  return /^[ \t]*@@@/;
}

/** `parsePermissionEntry`: a role holding no brackets, and an optional bracketed window. */
function permissionEntryPattern(): RegExp {
  return /^(?<role>[^\[\]]+?)(?:\s*\[(?<window>.+)\])?$/;
}

/** `parsePermissionWindow`: a window that names an end and no start. */
function windowEndOnlyPattern(): RegExp {
  return /^to\s+/i;
}

/** `parsePermissionWindow`: what stands between the two ends of a window. */
function windowSeparatorPattern(): RegExp {
  return /\s+to\s+/i;
}

/** `parseLocalDateTime`: the suffix that sends a timestamp straight to the Date constructor. */
function timezoneSuffixPattern(): RegExp {
  return /([zZ]|[+-]\d{2}:?\d{2})$/;
}

/** `parseLocalDateTime`: what stands between the date and the time. */
function dateTimeSeparatorPattern(): RegExp {
  return /[T ]/;
}

/**
 * `hasRoles`: the three switches it resolves.
 *
 * It takes *every* entry carrying the prefix out of the role test, whatever
 * follows it, and then resolves exactly these three. An entry carrying the
 * prefix and none of these names therefore restricts nobody and switches
 * nothing, which is a third thing to be and is marked as one.
 */
const VIEW_SWITCHES = ["exam", "practice", "answer"];

/**
 * `namesReservedForRoles` (`utils.js`): the five a display name may not be.
 *
 * Being addressed by name is a feature - the session's display name enters the
 * role set as a role, so `@@@ Stu Dent` reaches one person. These five are the
 * exception: a display name equal to one of them is dropped rather than added,
 * with a warning nobody reading the document will ever see. So a block addressed
 * to `Students` is addressed to the *role*, and every student in the school
 * reads it.
 *
 * Mirrored rather than imported, like the directive grammar above it and for the
 * same reason: the plugin ships to Obsidian as a standalone bundle with no
 * safeLearn checkout anywhere near it. It carries the same risk of drifting, and
 * `AI/architecture.md` §9 records it.
 */
const NAMES_RESERVED_FOR_ROLES = ["admin", "teacher", "teachers", "student", "students"];

/** Whether the server reads this as a role rather than as the person who bears it. */
function isReservedName(name: string): boolean {
  return NAMES_RESERVED_FOR_ROLES.includes(name.trim().toLowerCase());
}

/** An ATX heading, and how deep it is. */
function headingPattern(): RegExp {
  return /^(#{1,6})\s/;
}

/** Where something sits in the line, and what it says. */
type Span = { index: number; length: number; text: string };

/**
 * One comma-separated entry of a directive: where it is, and what the server
 * will make of it.
 *
 * The four conclusions are independent of one another rather than one
 * enumeration, because the server's are: an entry can be a view switch and
 * carry a window, and be marked as both.
 */
type DirectiveEntry = {
  index: number;
  length: number;
  /**
   * The entry as the document writes it - trimmed, and in the author's own
   * spelling. This is what a heading shows, because a heading that restated an
   * entry would claim a reading of it, and the server discards windows that a
   * readable restatement makes look sound.
   */
  text: string;
  /** The role as the server would hold it - trimmed and lowercased. */
  role: Span | null;
  /** The text between the brackets, as written. Null when the entry has no bracketed part. */
  window: Span | null;
  /** Whether the server keeps this entry at all, or drops it before anything reads it. */
  readable: boolean;
  timed: boolean;
  brokenWindow: boolean;
  viewSwitch: boolean;
  resolvedSwitch: boolean;
};

/**
 * Whether `parseLocalDateTime` would read this as a time - never what time it
 * denotes, which nothing here needs.
 *
 * This is the riskiest thing in the file, and it is written out step for step
 * rather than reasoned about, because that function is permissive in ways a
 * careful reading gets wrong in both directions: `2025-13-45` is accepted and
 * rolled over into the next year, `2025` is rejected because `month - 1` becomes
 * NaN two steps later, `2025-11-28T08:00` is rejected because the missing
 * seconds leave `second` undefined, and `2025-11-28 ab:cd` is accepted because a
 * segment that is not a number leaves the default in place. Each of those is a
 * row in the table `test/directive-grammar.test.js` holds in the safeLearn
 * repository, which runs this function and the server's over the same lines and
 * fails on a divergence.
 */
function readsAsTime(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (timezoneSuffixPattern().test(trimmed)) {
    return !Number.isNaN(new Date(trimmed).getTime());
  }
  const [datePart, timePart] = trimmed.split(dateTimeSeparatorPattern());
  if (!datePart) return !Number.isNaN(new Date(trimmed).getTime());

  const [year, month, day] = datePart.split("-").map((segment) => Number.parseInt(segment, 10));
  if ([year, month, day].some((segment) => Number.isNaN(segment))) return false;

  // Deliberately three assignments that can be skipped rather than three
  // defaults: a segment that parses to NaN leaves the default standing, and a
  // segment that is not there at all assigns `undefined` and invalidates the
  // whole date. The two look alike and do the opposite.
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (timePart) {
    const [h, m, s] = timePart.split(":").map((segment) => Number.parseInt(segment, 10));
    if (!Number.isNaN(h)) hour = h;
    if (!Number.isNaN(m)) minute = m;
    if (!Number.isNaN(s)) second = s;
  }
  return !Number.isNaN(new Date(year, month - 1, day, hour, minute, second).getTime());
}

/**
 * Whether `parsePermissionWindow` would keep this window.
 *
 * It keeps one as soon as either end reads as a time, and returns null when
 * neither does - and an entry whose window is null is permanently active. So
 * this answers the only question the marking depends on: does the restriction
 * the author wrote take effect at all.
 */
function readsAsWindow(value: string): boolean {
  const windowText = value.trim();
  if (!windowText) return false;
  if (windowEndOnlyPattern().test(windowText)) {
    return readsAsTime(windowText.replace(windowEndOnlyPattern(), ""));
  }
  const parts = windowText.split(windowSeparatorPattern());
  if (parts.length === 1) return readsAsTime(parts[0]);
  return readsAsTime(parts[0]) || readsAsTime(parts.slice(1).join(" to "));
}

/**
 * One entry of a directive, read the way `parsePermissionEntry` reads it.
 *
 * `offset` is where the token starts in the line; what is reported is the
 * trimmed extent, because the whitespace around an entry is not part of it and
 * marking it would say the server acts on characters it never sees.
 */
function readDirectiveEntry(token: string, offset: number): DirectiveEntry {
  const trimmed = token.trim();
  const index = offset + (token.length - token.trimStart().length);
  const discarded: DirectiveEntry = {
    index,
    length: trimmed.length,
    text: trimmed,
    role: null,
    window: null,
    readable: false,
    timed: false,
    brokenWindow: false,
    viewSwitch: false,
    resolvedSwitch: false,
  };
  if (!trimmed) return discarded;

  const match = permissionEntryPattern().exec(trimmed);
  const groups = match?.groups;
  if (!groups) return discarded;

  const rolePart = groups.role ?? "";
  const roleText = rolePart.trim().toLowerCase();
  if (!roleText) return discarded;

  // The role part is anchored at the start of the token, and the window group is
  // anchored to the closing bracket at its end - so both extents come from the
  // match rather than from searching the text for a bracket, which would find
  // one the server does not treat as a window.
  const windowText: string | undefined = groups.window;
  const window =
    windowText === undefined
      ? null
      : {
          index: index + trimmed.length - 1 - windowText.length,
          length: windowText.length,
          text: windowText,
        };
  const timed = window !== null && readsAsWindow(window.text);
  const viewSwitch = roleText.startsWith("#");

  return {
    index,
    length: trimmed.length,
    text: trimmed,
    role: { index, length: rolePart.trimEnd().length, text: roleText },
    window,
    readable: true,
    timed,
    brokenWindow: window !== null && !timed,
    viewSwitch,
    resolvedSwitch: viewSwitch && VIEW_SWITCHES.includes(roleText.slice(1)),
  };
}

/**
 * Every entry of a directive line, in order, or null if the line is not a
 * directive at all.
 *
 * Entry-shaped rather than one pattern over the line, because the server's own
 * decisions are per entry: one token's unreadable window does not touch its
 * neighbour, and one discarded token does not discard the rest. Entries the
 * server discards are reported too, marked as discarded - a caller that needs
 * only the surviving ones filters, and one that has to show where a discarded
 * entry sits can.
 */
function parseDirectiveEntries(text: string): DirectiveEntry[] | null {
  const opening = directiveOpeningPattern().exec(text);
  if (!opening) return null;

  const entries: DirectiveEntry[] = [];
  let offset = opening[0].length;
  for (const token of text.slice(offset).split(",")) {
    entries.push(readDirectiveEntry(token, offset));
    offset += token.length + 1; // the comma the split took out
  }
  return entries;
}

/**
 * Whether the server withholds this directive's text from every reader.
 *
 * `removeForbiddenContent` replaces a block whose directive keeps no entry with
 * the empty string, and `resolveFileVisibility` reports a file-level one
 * invisible - in both cases to everyone, an admin included. It is the harshest
 * thing a directive can do and the least visible, which is why it is a
 * conclusion about the line rather than something to infer from each entry.
 */
function withholdsFromEveryone(entries: DirectiveEntry[]): boolean {
  return !entries.some((entry) => entry.readable);
}

/** The text with every tag taken out of it, by the same rules the editor marks by. */
function withoutTags(text: string): string {
  return text
    .replace(fragmentPattern(), "")
    .replace(blockMarkerPattern(), "")
    .replace(permissionMarkerPattern(), "");
}

// ################### The heading a directive is shown as ###################

/**
 * What a restricted block is shown carrying instead of its directive line - the
 * way a table carries its header row.
 *
 * One builder for both views, because that is the whole reason the reading view
 * and the editor were settled in one change: two builders would be free to
 * disagree about the one thing both views exist to show the same way.
 *
 * Each entry becomes a chip of its own. A chip is not text in the document, so
 * it can carry visual channels an entry mark cannot - `styles.css` records why a
 * mark may only use colour, weight and line style, and none of that applies
 * here.
 */
function buildHeading(entries: DirectiveEntry[], fileLevel: boolean): HTMLElement {
  const heading = document.createElement("span");
  heading.className = "safelearn-heading";
  if (fileLevel) heading.classList.add("safelearn-heading-file");

  // Nothing on the line reads as an entry, so `removeForbiddenContent` replaces
  // the block with the empty string and `resolveFileVisibility` reports the file
  // invisible - to everyone, an admin included. A heading naming somebody would
  // claim the opposite of what happens, and no heading at all would be the one
  // line that disappears without a trace.
  if (withholdsFromEveryone(entries)) {
    heading.classList.add("safelearn-heading-withheld");
    const note = document.createElement("span");
    note.className = "safelearn-heading-note";
    note.textContent = "no reader sees this block";
    heading.appendChild(note);
    return heading;
  }

  for (const entry of entries) {
    if (entry.text === "") continue;
    heading.appendChild(buildChip(entry));
  }
  return heading;
}

/**
 * One entry of a directive, as its own element.
 *
 * The text is the entry as the document writes it, window and all. Nothing is
 * restated: the server throws away windows that a readable restatement would
 * make look sound, and the plugin's only value is that it claims nothing of an
 * entry that the server does not do with it.
 *
 * An entry the server discards is shown too, marked as discarded. Where the
 * characters are on the page, a discarded entry is shown by the marking its
 * neighbours have and it does not - but here the characters are gone, and
 * leaving the entry out would hide from the author that they wrote something the
 * server throws away.
 */
function buildChip(entry: DirectiveEntry): HTMLElement {
  const chip = document.createElement("span");
  const classes = ["safelearn-chip"];
  if (!entry.readable) classes.push("safelearn-chip-discarded");
  if (entry.timed) classes.push("safelearn-chip-timed");
  if (entry.brokenWindow) classes.push("safelearn-chip-broken");
  if (entry.viewSwitch) classes.push("safelearn-chip-switch");
  if (entry.viewSwitch && !entry.resolvedSwitch) classes.push("safelearn-chip-unresolved");
  chip.className = classes.join(" ");
  chip.textContent = entry.text;
  return chip;
}

// ################### The rendered reading view ###################

/**
 * Takes the tags out of the rendered reading view, and puts in their place what
 * they mean.
 *
 * Obsidian calls this once per rendered section and hands over a context that
 * can say which lines of the file that section was rendered from -
 * `getSectionInfo` returns the whole document text with the section's line
 * range. So what a section *is* comes from the source, resolved by the same walk
 * the editor uses, rather than from testing rendered text for something that
 * looks like a tag. That is what the function this replaced could not do: by the
 * time output is rendered the line structure is gone, so it could only ever
 * hide - never put a heading in a marker's place, never tell which content
 * belonged to which column.
 *
 * `getSectionInfo` returns null wherever there is no file section behind the
 * render: Live Preview, an embed, a hover preview, and the columns this function
 * renders itself. Then the one thing that needs no source still happens - tag
 * text goes - and nothing is asserted that cannot be established. It is also
 * what stops the column rendering below from recursing into itself.
 */
async function hideTags(el: HTMLElement, ctx: MarkdownPostProcessorContext, plugin: Plugin) {
  const info = ctx.getSectionInfo(el);
  if (!info) {
    stripTagText(el);
    return;
  }

  const lines = linesOfText(info.text);
  const { blocks, fileDirective } = resolveBlocks(lines);
  // `getSectionInfo` counts lines from zero and names the last line of the
  // section inclusive; everything else in this file counts from one.
  const from = info.lineStart + 1;
  const to = info.lineEnd + 1;

  const covering = (kind: Block["kind"]) =>
    blocks.filter((block) => block.kind === kind && block.from <= to && block.to >= from);
  const opens = (block: Block) => block.from >= from && block.from <= to;
  const closes = (block: Block) => block.to >= from && block.to <= to;

  const columns = covering("side-by-side");
  if (columns.length > 0) {
    // Every section of the block decides about itself, from the source alone.
    // The one holding the opening marker renders the whole block as columns; the
    // rest go. Nothing waits for another section to exist and nothing is moved
    // between parents, so a block scrolled half into view cannot end up half
    // built.
    //
    // A section can lie across more than one block where two of them stand with
    // no blank line between; the one that *opens* in it decides, because that is
    // the section that has to produce something.
    const opening = columns.find(opens);
    if (opening) await renderColumns(el, opening, lines, ctx, plugin);
    else el.addClass("safelearn-hidden");
    return;
  }

  // The box is drawn one section at a time, the way the editor draws it one line
  // at a time: sides on every part of it, a lid on the first, a floor on the
  // last. Every block covering this section is asked, not the first one found -
  // a paragraph holding one block's closing marker and the next one's directive
  // is the lid of the second as much as the floor of the first.
  for (const block of covering("permission")) {
    el.addClass("safelearn-read-block");
    if (opens(block)) el.addClass("safelearn-read-block-start");
    if (closes(block)) el.addClass("safelearn-read-block-end");
  }
  if (fileDirective !== null && fileDirective >= from && fileDirective <= to) {
    el.addClass("safelearn-read-file");
  }

  // Which of this section's lines are tag lines is decided here, from the walk
  // above; the text nodes below are only where those lines ended up.
  const headings = new Map<string, { entries: DirectiveEntry[]; fileLevel: boolean }>();
  const closings = new Set<string>();
  for (let line = from; line <= to; line++) {
    const text = lines.at(line);
    const opensBlock = blocks.some((b) => b.kind === "permission" && b.from === line);
    if (line === fileDirective || opensBlock) {
      const entries = parseDirectiveEntries(text);
      if (entries !== null) headings.set(text.trim(), { entries, fileLevel: line === fileDirective });
    } else if (closesPermissionBlock(text)) {
      closings.add(text.trim());
    }
  }

  replaceTagLines(el, headings, closings);
  stripTagText(el);

  // A section whose lines held nothing but tags has nothing left to show - and
  // that is asked of the source, like everything else here, rather than of the
  // rendered result. A section can be empty of text and be an image, a rule or a
  // diagram, and hiding it because nothing in it is a word would take content
  // out of a document to remove a tag that was never in it.
  //
  // Unless a heading was put there: a directive line does hold nothing but a
  // tag, and what stands in its place now is the point of the whole change.
  const held: string[] = [];
  for (let line = from; line <= to; line++) held.push(lines.at(line));
  if (withoutTags(held.join("\n")).trim() === "" && el.querySelector(".safelearn-heading") === null) {
    el.addClass("safelearn-hidden");
  }
}

/**
 * The element inside a rendered section that holds the section's own lines.
 *
 * Obsidian hands a post-processor the section's wrapper - `div.el-p` around the
 * paragraph, `div.el-ul` around the list - and the lines are one level further
 * in. The wrapper is where a frame belongs, because it is the full-width element
 * and adjacent wrappers touch; the block inside it is where the lines are. Only
 * a wrapper is stepped through, and only when it holds that one block and
 * nothing else, so a paragraph is never mistaken for the single element it
 * happens to contain.
 */
const SECTION_BLOCKS = new Set(["P", "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6"]);

function sectionBody(el: HTMLElement): HTMLElement {
  if (el.tagName !== "DIV" || el.childNodes.length !== 1) return el;
  const only = el.firstElementChild;
  return only instanceof HTMLElement && SECTION_BLOCKS.has(only.tagName) ? only : el;
}

/**
 * A rendered section, cut back into the lines it was rendered from.
 *
 * A section is one paragraph and a paragraph is several lines: Obsidian renders
 * a single newline as a break, so the lines arrive as runs of nodes with `<br>`
 * between them. A run is what a line became, and each run carries the break that
 * ended it, so removing a line removes the gap it occupied with it.
 *
 * A run rather than a node, because one line is not one node. `#exam` in a
 * directive is rendered as a tag link of its own, so the line arrives as text,
 * an anchor and more text - and a rule that looked at single text nodes would
 * see three fragments of a directive and recognize none of them.
 */
function renderedLines(body: HTMLElement): ChildNode[][] {
  const runs: ChildNode[][] = [[]];
  for (const node of Array.from(body.childNodes)) {
    runs[runs.length - 1].push(node);
    if (node instanceof HTMLBRElement) runs.push([]);
  }
  if (runs[runs.length - 1].length === 0) runs.pop();
  return runs;
}

/** What a rendered line says, as one string. */
function textOfLine(run: ChildNode[]): string {
  return run.map((node) => node.textContent ?? "").join("").trim();
}

/**
 * Replaces the rendered line of a directive with its heading, and removes the
 * rendered line of a closing marker.
 *
 * Which lines are tag lines was decided by the walk over the source; this only
 * finds where they ended up, by the text of the line. That is how the
 * recognition rules match everywhere else in this file.
 */
function replaceTagLines(
  el: HTMLElement,
  headings: Map<string, { entries: DirectiveEntry[]; fileLevel: boolean }>,
  closings: Set<string>
) {
  if (headings.size === 0 && closings.size === 0) return;

  for (const run of renderedLines(sectionBody(el))) {
    const text = textOfLine(run);
    if (text === "") continue;

    const heading = headings.get(text);
    if (heading) {
      run[0].before(buildHeading(heading.entries, heading.fileLevel));
      for (const node of run) {
        if (!(node instanceof HTMLBRElement)) node.remove();
      }
      continue;
    }
    if (closings.has(text)) {
      for (const node of run) node.remove();
    }
  }
}

/**
 * Takes tag text out of the node that holds it, by rewriting that node's own
 * data.
 *
 * Deliberately not by building a replacement node: a text node replaced by a
 * fresh `<span>` loses its place in whatever wrapped it, and a tag written in a
 * line that carries emphasis or a link took that formatting with it. Rewriting
 * the data leaves the node, its parent and everything around it exactly as
 * Obsidian rendered them.
 */
function stripTagText(el: HTMLElement) {
  for (const node of textNodesOf(el)) {
    // A heading this plugin built is not rendered document text, and the entry
    // it carries is the author's own spelling rather than a tag to be removed.
    if (node.parentElement?.closest(".safelearn-heading")) continue;
    const original = node.data;
    const remaining = withoutTags(original);
    if (remaining !== original) node.data = remaining;
  }
}

/** Every text node under an element, collected before anything is changed. */
function textNodesOf(el: HTMLElement): globalThis.Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const found: globalThis.Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    found.push(node as globalThis.Text);
  }
  return found;
}

/**
 * Renders a side-by-side block as the columns the server makes of it.
 *
 * The split is `preprocessSideBySide`'s (`obsidian.js:885`): the two markers are
 * taken out, what is left is split on `##separator`, and each part is trimmed.
 * The server then wraps each part in a `<div>` with blank lines around it,
 * because at that point the content is still Markdown and Markdown inside an
 * HTML block is only parsed when an empty line separates it from the tags. Here
 * each part is handed to Obsidian's renderer as Markdown directly, so there is
 * nothing for a blank line to do.
 *
 * The block's content is therefore rendered twice - once by Obsidian into the
 * sections that then hide themselves, once here. That is the price of not
 * reaching into the container Obsidian is still filling, and it is paid on the
 * two short blocks a document holds rather than on a document.
 */
async function renderColumns(
  el: HTMLElement,
  block: Block,
  lines: LineSource,
  ctx: MarkdownPostProcessorContext,
  plugin: Plugin
) {
  // A block that is never closed ends at the end of the document, and that last
  // line is content rather than a marker to step over.
  const closed = isMarkerLine(lines.at(block.to), SIDE_BY_SIDE_END);
  const content: string[] = [];
  for (let line = block.from + 1; line <= (closed ? block.to - 1 : block.to); line++) {
    content.push(lines.at(line));
  }

  const container = document.createElement("div");
  container.className = "safelearn-columns";
  for (const source of content.join("\n").split(SEPARATOR)) {
    const column = document.createElement("div");
    column.className = "safelearn-column";
    container.appendChild(column);
    await MarkdownRenderer.render(plugin.app, source.trim(), column, ctx.sourcePath, plugin);
  }

  // The section is not necessarily the block: an opening marker sits in the same
  // paragraph as the sentence above it, and a short block sits inside one
  // paragraph whole. Only the lines that are the block's are taken out, and the
  // columns go where they stood.
  el.addClass("safelearn-columns-host");
  const body = sectionBody(el);
  const runs = renderedLines(body);
  const first = runs.findIndex((run) => textOfLine(run) === SIDE_BY_SIDE_START);

  // The opening marker is not a line of its own where a list swallowed it as a
  // lazy continuation - a document nobody writes, but one that must not lose its
  // content to a guess about which runs to take out. The section goes whole and
  // the columns stand in its place.
  if (first === -1) {
    body.addClass("safelearn-hidden");
    el.appendChild(container);
    return;
  }

  const closing = runs.findIndex((run, index) => index >= first && textOfLine(run) === SIDE_BY_SIDE_END);
  const last = closing === -1 ? runs.length - 1 : closing;

  runs[first][0].before(container);
  for (let index = first; index <= last; index++) {
    for (const node of runs[index]) node.remove();
  }
  while (body.lastChild instanceof HTMLBRElement) body.lastChild.remove();
}

// ################### The blocks a document is made of ###################

type Block = {
  kind: "permission" | "side-by-side";
  from: number;
  to: number;
  /**
   * Whether `to` is the block's closing marker, or the last line of a document
   * that never closed it. The walk below knows which of the two it settled on,
   * and what stands on that line depends on the answer: a marker is the block's
   * own punctuation and is hidden as such, the last line of an unclosed block is
   * somebody's text.
   */
  closed: boolean;
  separators: number[];
};

/**
 * What one walk of the document found: its blocks, and the line of the
 * file-level directive if it has one.
 *
 * The file-level line is reported rather than left to be recognized a second
 * time where it is marked. Two places deciding which line gates the file would
 * be free to disagree about it, and the whole reason the recognition rules sit
 * in one block at the top of this file is that a tag form with two rules is what
 * let the editor and the reading view drift apart.
 */
type DocumentStructure = { blocks: Block[]; fileDirective: number | null };

/**
 * The lines of a document, however the caller happens to hold them.
 *
 * The editor has CodeMirror's `Text`; the rendered reading view has the file's
 * text as a string, handed to it with each section. Both resolve blocks by the
 * walk below, over this, so the two views cannot develop a second opinion about
 * where a block ends. Lines are numbered from 1, the way CodeMirror numbers
 * them.
 */
type LineSource = { count: number; at(line: number): string };

function linesOfText(text: string): LineSource {
  const lines = text.split("\n");
  return { count: lines.length, at: (line) => lines[line - 1] ?? "" };
}

function linesOfDocument(doc: Text): LineSource {
  return { count: doc.lines, at: (line) => doc.line(line).text };
}

/**
 * Every block in the document, resolved over all of it.
 *
 * Over all of it rather than over what is on screen, because a block opened
 * three screens up still governs the lines currently visible - the visible range
 * alone does not say what is inside a block and what is not. Walking lines is
 * cheap next to building decorations, and it keeps the marking independent of
 * where the document happens to be scrolled to. See `AI/architecture.md` for the
 * trade-off this accepts on a very large document.
 *
 * Nothing here suppresses anything after it. A marker that cannot be made sense
 * of costs its own line: the block it belongs to still ends somewhere, and the
 * tags below it are marked as they would be in a document without it.
 */
function resolveBlocks(lines: LineSource): DocumentStructure {
  const blocks: Block[] = [];

  // A first line beginning with `@@@` is the file-level form, which gates the
  // whole file and has no closing marker. The renderer splits that line off the
  // document before it looks for a block at all, so this is what it is by
  // position rather than by what follows it: read as an unclosed block instead,
  // it swallows every marking below it.
  const fileDirective = isFileLevelDirective(lines.at(1)) ? 1 : null;
  const start = fileDirective === null ? 1 : 2;

  let permissionFrom = -1;
  let sideFrom = -1;
  let separators: number[] = [];

  for (let i = start; i <= lines.count; i++) {
    const text = lines.at(i);

    if (permissionFrom === -1) {
      if (opensPermissionBlock(text)) {
        permissionFrom = i;
        continue;
      }
      // A closing marker with nothing open closes nothing and opens nothing.
    } else if (closesPermissionBlock(text)) {
      blocks.push({ kind: "permission", from: permissionFrom, to: i, closed: true, separators: [] });
      permissionFrom = -1;
      continue;
    }

    if (sideFrom === -1) {
      if (isMarkerLine(text, SIDE_BY_SIDE_START)) {
        sideFrom = i;
        separators = [];
        continue;
      }
    } else if (isMarkerLine(text, SIDE_BY_SIDE_END)) {
      blocks.push({ kind: "side-by-side", from: sideFrom, to: i, closed: true, separators });
      sideFrom = -1;
      continue;
    } else if (isMarkerLine(text, SEPARATOR)) {
      // A separator outside a block is left alone, the way the renderer leaves
      // it alone: it only means anything between a start and an end.
      separators.push(i);
    }
  }

  // A block that is never closed ends at the end of the document and marks what
  // it covered, rather than costing everything after it its marking.
  if (permissionFrom !== -1) {
    blocks.push({ kind: "permission", from: permissionFrom, to: lines.count, closed: false, separators: [] });
  }
  if (sideFrom !== -1) {
    blocks.push({ kind: "side-by-side", from: sideFrom, to: lines.count, closed: false, separators });
  }

  return { blocks, fileDirective };
}

// ################### What the editor marks ###################

/**
 * What one entry of a directive is marked with, or null for an entry the server
 * discards.
 *
 * A discarded entry is marked as nothing at all. The only thing a marking on it
 * could say is that the server acts on it, and the server does not: it is
 * dropped before anything reads it, and the entries beside it go on meaning what
 * they meant. So it is shown by the marking its neighbours have and it does not.
 *
 * The rest are attributes on one shared marking rather than a class per
 * combination: the conclusions are independent of one another - an entry can be
 * a view switch and carry a window - and a class per combination is a dozen
 * classes that mostly never occur. What each of them looks like is settled in
 * `styles.css`, which is the only place that question can honestly be answered.
 */
function entryClasses(entry: DirectiveEntry): string | null {
  if (!entry.readable) return null;
  const classes = ["safelearn-entry"];
  if (entry.timed) classes.push("safelearn-entry-timed");
  if (entry.brokenWindow) classes.push("safelearn-entry-broken");
  if (entry.viewSwitch) classes.push("safelearn-entry-switch");
  if (entry.viewSwitch && !entry.resolvedSwitch) classes.push("safelearn-entry-unresolved");
  return classes.join(" ");
}

/**
 * The heading that stands in the editor where a directive line's characters are.
 *
 * It compares equal on the text it was built from, so a rebuild that changed
 * nothing hands the editor back a widget it can keep. Without that, every cursor
 * move in the document would tear down and rebuild every heading on screen.
 *
 * Events are not ignored, so a click lands in the range the widget replaces and
 * places the cursor there - which is what lifts the replacement on the next
 * rebuild. The range is deliberately not atomic: a range the cursor cannot enter
 * would need something else to lift it, and every one of those is a way for the
 * line to become uneditable when it fails.
 */
class DirectiveHeadingWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly fileLevel: boolean
  ) {
    super();
  }

  eq(other: DirectiveHeadingWidget): boolean {
    return other.source === this.source && other.fileLevel === this.fileLevel;
  }

  toDOM(): HTMLElement {
    return buildHeading(parseDirectiveEntries(this.source) ?? [], this.fileLevel);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** What a fragment marker is shown as. Written here rather than in `styles.css`: see below. */
const FRAGMENT_ICON = "🔀";

/**
 * The icon that stands in the editor where a fragment marker's characters are.
 *
 * A fragment says one small thing - that what follows it waits for a click - and
 * it says it about a line that is otherwise ordinary prose. Spelled out and
 * framed, the tag was the loudest thing on that line; as an icon it says the same
 * thing in the room a punctuation mark takes. What it replaces comes back the
 * moment the cursor touches it, exactly as a directive line's characters do, so
 * the tag is still there to be edited by the person who wrote it.
 *
 * The icon is a character in the element rather than `content` in the stylesheet,
 * which is where this plugin's other icons are. Those decorate text that is on
 * screen either way; this one *is* what is on screen in the tag's place, and a
 * stylesheet that failed to load would otherwise take the tag off the page
 * without leaving anything behind.
 *
 * Every fragment is shown the same way, so they all compare equal and the editor
 * keeps the elements it already built across a rebuild - and a rebuild now
 * happens on every cursor move.
 */
class FragmentIconWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "fragment-icon";
    icon.textContent = FRAGMENT_ICON;
    return icon;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * What the document says about each of its lines, read once.
 *
 * There are two consumers of it and they must not answer differently: the
 * decoration set below, which reaches the elements the editor renders as lines,
 * and `frameBlocks`, which reaches the ones it does not. Both read `lineClasses`
 * rather than walking the document again - a second walk would be a second
 * opinion about where a block ends.
 */
type DocumentMarking = {
  /** Per line number, the classes the blocks covering it put on it. */
  lineClasses: Map<number, string[]>;
  /** Per line number, the entries of the directive standing on it. */
  directives: Map<number, DirectiveEntry[]>;
  /** The lines that close a permission block, and therefore hold nothing else. */
  closers: Set<number>;
  fileDirective: number | null;
};

function markLines(doc: Text): DocumentMarking {
  // What each line carries by virtue of the blocks covering it, for the whole
  // document. It becomes decorations where the editor renders a line as a line,
  // and a class written onto the element where it renders one as something else.
  const lineClasses = new Map<number, string[]>();
  const carries = (line: number, className: string) => {
    const classes = lineClasses.get(line);
    if (classes) classes.push(className);
    else lineClasses.set(line, [className]);
  };

  const { blocks, fileDirective } = resolveBlocks(linesOfDocument(doc));

  // Every line the plugin reads as a directive, with what its text comes to.
  // Which lines those are is what the walk above decided - the file-level line
  // and the line each permission block opens with - rather than something asked
  // again here.
  const directives = new Map<number, DirectiveEntry[]>();
  const readDirective = (line: number) => {
    const entries = parseDirectiveEntries(doc.line(line).text);
    if (entries !== null) directives.set(line, entries);
  };
  if (fileDirective !== null) readDirective(fileDirective);

  // The other end of the same blocks. A closing marker is punctuation and
  // nothing else - there is no text of anybody's on that line to lose - so the
  // editor is told which lines they are and shows them the way it shows the
  // directive above them. Which lines those are is again the walk's conclusion,
  // including its conclusion that a block was closed at all.
  const closers = new Set<number>();
  for (const block of blocks) {
    if (block.kind !== "permission") continue;
    readDirective(block.from);
    if (block.closed) closers.add(block.to);
  }

  // The file-level form gates the whole document and has no closing marker; the
  // same text on any other line gates the region below it. Two different
  // promises about two different amounts of text, and they are marked apart.
  if (fileDirective !== null) carries(fileDirective, "permission-file");

  for (const [line, entries] of directives) {
    if (withholdsFromEveryone(entries)) carries(line, "permission-withheld");
  }

  for (const block of blocks) {
    for (let i = block.from; i <= block.to; i++) {
      if (block.kind === "permission") {
        // Every line of the block, and its two ends besides. A box is drawn one
        // element at a time, so which side of it a line is on is something the
        // marking has to say - the side-by-side block is drawn the same way for
        // the same reason. It is no new conclusion about the document: the
        // block's first and last line are what `resolveBlocks` already found.
        carries(i, "permission-block");
        if (i === block.from) carries(i, "permission-block-start");
        if (i === block.to) carries(i, "permission-block-end");
      } else {
        carries(
          i,
          i === block.from ? "side-by-side-start" : i === block.to ? "side-by-side-end" : "side-by-side-block"
        );
      }
    }
    for (const line of block.separators) carries(line, "side-by-side-separator");
  }

  return { lineClasses, directives, closers, fileDirective };
}

function buildDecorations(view: EditorView, marking: DocumentMarking): DecorationSet {
  const doc = view.state.doc;
  const { lineClasses, directives, closers, fileDirective } = marking;

  // Only the lines on screen produce decorations. A rebuild now happens on every
  // cursor move as well as on every keystroke, and there is nothing to gain from
  // constructing decorations for lines the editor has not built an element for.
  const visibleLines = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) visibleLines.add(i);
  }

  // A directive line stands as its heading while nothing is in it, and as its
  // own characters while something is. "Something" is the cursor resting in the
  // line or a selection touching it: a selection running across the block shows
  // the line, because otherwise a person copies text they cannot see. The lines
  // above and below are not consulted, so scrolling through with the cursor does
  // not make the document flicker.
  const isTouched = (from: number, to: number) =>
    view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);

  const ranges: Range<Decoration>[] = [];
  for (const number of visibleLines) {
    const line = doc.line(number);
    for (const className of lineClasses.get(number) ?? []) {
      ranges.push(Decoration.line({ class: className }).range(line.from));
    }

    // Everything below marks characters, and a replaced line has none on screen.
    // A mark inside hidden text says nothing, so the two states are exactly the
    // heading and what a directive line has always shown, with nothing between.
    if (directives.has(number) && !isTouched(line.from, line.to) && line.from < line.to) {
      ranges.push(
        Decoration.replace({
          widget: new DirectiveHeadingWidget(line.text, number === fileDirective),
        }).range(line.from, line.to)
      );
      continue;
    }

    // The same rule again, for the marker that closes the block. The directive
    // above it has a heading to stand in its place; this one has nothing to say
    // that the frame around the block does not already say, so what stands in
    // its place is the blank line the frame closes on. It is hidden rather than
    // made unreachable: the line stays where it is and the cursor can still be
    // put in it, which is what brings the marker back to be edited or deleted -
    // the only way there is to open the block up again.
    if (closers.has(number) && !isTouched(line.from, line.to)) {
      ranges.push(Decoration.replace({}).range(line.from, line.to));
      continue;
    }

    // The same rule the directive line above follows, applied to a tag rather
    // than to a whole line: the icon stands for the tag while nothing is in it,
    // and the tag's own characters stand there while something is. The extent
    // asked about is the tag's, not the line's - two fragments in one line are
    // two independent answers, and a person editing one keeps the other quiet.
    for (const { index, length } of fragmentsIn(line.text)) {
      const from = line.from + index;
      const to = from + length;
      ranges.push(
        isTouched(from, to)
          ? Decoration.mark({ class: "fragment-highlight" }).range(from, to)
          : Decoration.replace({ widget: new FragmentIconWidget() }).range(from, to)
      );
    }
    for (const entry of directives.get(number) ?? []) {
      const classes = entryClasses(entry);
      if (classes === null) continue;
      ranges.push(
        Decoration.mark({ class: classes }).range(line.from + entry.index, line.from + entry.index + entry.length)
      );
    }
  }

  // The library sorts, rather than this plugin. The order a decoration set has
  // to be in is by position *and* by the side each range starts at, and the
  // second is a property of the decoration type that only the library knows - a
  // line marking and a tag marking beginning at the same offset are not
  // interchangeable. Getting it wrong is not a wrong marking but no markings at
  // all: the set is rejected whole.
  return Decoration.set(ranges, true);
}

/**
 * Every class a block puts on a line, and therefore every class the pass below
 * is allowed to take off an element again.
 *
 * It is only needed for removal: what is added comes straight out of
 * `lineClasses`, so a class this list forgot is still applied. What a forgotten
 * class would cost is the other half - a frame left standing on an element after
 * the block stopped covering it.
 */
const BLOCK_CLASSES = Object.freeze([
  "permission-file",
  "permission-withheld",
  "permission-block",
  "permission-block-start",
  "permission-block-end",
  "side-by-side-start",
  "side-by-side-block",
  "side-by-side-end",
  "side-by-side-separator",
]);

/**
 * Puts the block's classes on the elements the editor renders in place of lines.
 *
 * A block's frame is a `Decoration.line`, and Live Preview does not render every
 * line as a line: a table, a callout, a diagram, a formula and an embedded note
 * each arrive as a `div` that is a sibling of the `cm-line` elements rather than
 * one of them. A line decoration has nothing to attach to there, so the frame
 * stopped above such an element and started again below it - the block read as
 * two boxes that do not close. `posAtDOM` maps the element back to the line it
 * was built from, and that line has already been classified.
 *
 * Two children are passed over, for two different reasons. A `cm-line` is
 * already carrying its classes from the decoration set, and writing them again
 * would be a second opinion about the same element. A `cm-gap` stands for the
 * whole stretch of document the editor has scrolled away and built nothing for -
 * one element covering many lines - so framing it by the single line it resolves
 * to would paint a block's frame across an arbitrary part of the document.
 *
 * Classes are removed as well as added. That is what keeps a frame from standing
 * on an element after the block's closing marker moved above it.
 */
function frameBlocks(view: EditorView, lineClasses: Map<number, string[]>): void {
  for (const element of Array.from(view.contentDOM.children)) {
    if (element.classList.contains("cm-line") || element.classList.contains("cm-gap")) continue;

    let carried: string[];
    try {
      carried = lineClasses.get(view.state.doc.lineAt(view.posAtDOM(element)).number) ?? [];
    } catch {
      // An element the editor does not own has no line to answer for. Skipping
      // it is the whole handling: an update must not fail over a stray child.
      continue;
    }

    // `classList` writes nothing when the token is already in the state asked
    // for, so running this twice over an unchanged document touches no
    // attribute - which is what lets the observer below call it as often as it
    // likes. And a class written on a child is not a change to the child *list*,
    // so these writes cannot be what wakes that observer up.
    for (const className of carried) element.classList.add(className);
    for (const className of BLOCK_CLASSES) {
      if (!carried.includes(className)) element.classList.remove(className);
    }
  }
}

const safelearnHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    /** What each line carries, kept so the pass over the DOM reads the same answer. */
    lineClasses: Map<number, string[]>;

    /**
     * Watches for the elements Obsidian fills in after the update that produced
     * their range - a diagram and an embedded note are both built asynchronously
     * and replace the child that stood there. The pass after an update cannot
     * see those, because at that moment they do not exist yet.
     *
     * The child list of `.cm-content` and not its subtree: what arrives late is
     * a *replaced child*, and a subtree observer would fire on every keystroke
     * inside every line for nothing.
     */
    observer: MutationObserver;

    constructor(view: EditorView) {
      const marking = markLines(view.state.doc);
      this.lineClasses = marking.lineClasses;
      this.decorations = buildDecorations(view, marking);

      this.observer = new MutationObserver(() => this.frame(view));
      this.observer.observe(view.contentDOM, { childList: true });
      this.frame(view);
    }

    update(update: ViewUpdate) {
      // Text is not the only thing that changes what has to be marked. The
      // editor builds only the lines around the viewport, so scrolling brings in
      // lines nothing has looked at yet; and in Live Preview a tag is shown as
      // its own characters when the cursor enters it, which is a change in what
      // is on screen with no change to the document at all.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const marking = markLines(update.state.doc);
        this.lineClasses = marking.lineClasses;
        this.decorations = buildDecorations(update.view, marking);
      }
      this.frame(update.view);
    }

    destroy() {
      this.observer.disconnect();
    }

    /**
     * Runs the pass in the write phase of a measure cycle, so that nothing is
     * written to the DOM in the middle of an update the editor is still doing.
     * The key is what collapses several requests in one cycle into one pass.
     */
    frame(view: EditorView) {
      view.requestMeasure({
        key: this,
        read: () => null,
        write: () => frameBlocks(view, this.lineClasses),
      });
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// ################### The tags the plugin writes ###################

/**
 * The tags are typed by hand today, and a side-by-side block is four lines of
 * them with a spelling nobody remembers. A marker with a typo is marked by
 * nothing and acted on by nobody: it stands in the document as text a reader
 * meets in the middle of a lecture. The plugin knows what these tags are, so it
 * can write them.
 *
 * Everything below writes the constants the recognition rules at the top of this
 * file read. A command therefore cannot produce a tag the plugin does not mark,
 * which is the only guarantee here worth having.
 */

/** One thing the plugin can write into a document. */
type AuthoringCommand = {
  id: string;
  name: string;
  run(editor: Editor, plugin: SafeLearnPlugin): void;
};

/** Where the plugin's entries stand in a context menu it does not own. */
const MENU_SECTION = "safelearn";

/**
 * Every authoring command, in one list.
 *
 * `onload` builds both the palette entries and the context menu from this, and
 * the permission sections that come later are entries here rather than a second
 * menu beside it.
 */
const AUTHORING_COMMANDS: AuthoringCommand[] = [
  {
    id: "insert-side-by-side",
    name: "Insert side-by-side block",
    run: (editor) => insertSideBySide(editor, 2),
  },
  {
    // Three columns come up now and then, but not often enough to earn an entry
    // of their own that a person reads past every time. So: two without asking,
    // and one command that asks.
    id: "insert-side-by-side-columns",
    name: "Insert side-by-side block with a chosen number of columns",
    run: (editor, plugin) =>
      new ColumnCountModal(plugin.app, (columns) => insertSideBySide(editor, columns)).open(),
  },
  {
    id: "insert-fragment",
    name: "Insert fragment marker",
    run: (editor) => insertFragment(editor),
  },
  {
    id: "insert-sections-per-name",
    name: "Insert a restricted section for each name",
    run: (editor, plugin) =>
      new NameListModal(
        plugin.app,
        "A restricted section for each name",
        (names) => insertSectionsPerName(editor, names)
      ).open(),
  },
  {
    id: "restrict-selection",
    name: "Restrict the selection to named readers",
    run: (editor, plugin) =>
      new NameListModal(plugin.app, "Restrict what is selected to", (entries) =>
        restrictSelection(editor, entries)
      ).open(),
  },
];

/**
 * Writes a side-by-side block of `columns` columns, around a selection if there
 * is one.
 *
 * A selection is enclosed whole and no separator is written into it. Somebody
 * who selected several paragraphs does not want them divided at a place a
 * command guessed; the separators go after the content, where they are a line to
 * move rather than a division to undo. The block is well-formed either way -
 * `columns` columns, the first holding the selection and the rest waiting.
 *
 * Each further column is a separator and an empty line. A separator sitting
 * directly above the closing marker is an empty column with no room in it, and a
 * person would have to make that room before they could type.
 */
function insertSideBySide(editor: Editor, columns: number) {
  // Fewer than two is not a side-by-side block. The modal refuses it as well;
  // this is the rule rather than the dialog's validation.
  if (columns < 2) return;

  const selection = editor.getSelection();
  const content = selection === "" ? [""] : selection.split("\n");

  const lines = [SIDE_BY_SIDE_START, ...content];
  for (let column = 1; column < columns; column++) lines.push(SEPARATOR, "");
  lines.push(SIDE_BY_SIDE_END);

  // The first empty column either way: the content line when nothing was
  // selected, the line after the first separator when something was.
  writeLines(editor, lines, selection === "" ? 1 : content.length + 2);
}

/**
 * Writes a fragment marker on a line of its own, before the block the cursor is
 * in.
 *
 * "Before the block" rather than before the cursor's own line: in the middle of
 * a paragraph the second reading divides the paragraph and makes a fragment of
 * its second half, which is not what was asked for and is invisible until the
 * deck is opened. The block is the run of non-blank lines the cursor stands in.
 *
 * With a selection the marker goes above where the selection starts, because
 * that is the place a person pointed at.
 */
function insertFragment(editor: Editor) {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");

  let line = from.line;
  if (editor.getSelection() === "") {
    while (line > firstWritableLine(editor) && editor.getLine(line - 1).trim() !== "") line--;
  }

  editor.replaceRange(`${FRAGMENT}\n`, { line, ch: 0 }, { line, ch: 0 });
  // Everything from the insertion down moved one line; the person is put back
  // where they were writing.
  editor.setSelection({ line: from.line + 1, ch: from.ch }, { line: to.line + 1, ch: to.ch });
}

/**
 * Puts `lines` into the document, on lines of their own, and leaves the cursor
 * on the one at `cursorLine`.
 *
 * A marker sharing a line with other text is a marker this plugin does not mark
 * - `isMarkerLine` requires the line to be nothing but the marker, which is
 * deliberately stricter than the renderer and is recorded as a divergence in
 * `AI/architecture.md`. So an insertion that starts inside a line starts with a
 * break, and one that leaves text behind it ends with one.
 *
 * The blank lines the server puts around a column are not written here.
 * `preprocessSideBySide` adds them as it builds the columns, because the content
 * is still Markdown at that point and Markdown inside an HTML block is only
 * parsed when an empty line separates it from the tags. Written into the
 * document they would be trimmed straight back off.
 */
function writeLines(editor: Editor, lines: string[], cursorLine: number) {
  let from = editor.getCursor("from");
  let to = editor.getCursor("to");

  // Nothing is written above a directive that gates the file. It gates the file
  // by standing on the first line and by nothing else, so an insertion at the
  // very top pushes it down to the second and the document becomes readable by
  // everyone - silently, and through a command somebody ran to add a column.
  //
  // Only where nothing is selected. A selection covering that line is a
  // different act: the person named it, and what happens is shown by the marking
  // that stops saying the file is gated.
  const collapsed = from.line === to.line && from.ch === to.ch;
  if (collapsed && from.line === 0 && from.ch === 0 && isFileLevelDirective(editor.getLine(0))) {
    from = { line: 0, ch: editor.getLine(0).length };
    to = from;
  }

  const trailing = editor.getLine(to.line).slice(to.ch);
  const prefix = from.ch === 0 ? "" : "\n";
  const suffix = trailing === "" ? "" : "\n";
  editor.replaceRange(prefix + lines.join("\n") + suffix, from, to);

  const start = from.line + (prefix === "" ? 0 : 1);
  editor.setCursor({ line: start + cursorLine, ch: lines[cursorLine].length });
}

/**
 * The first line anything may be written above.
 *
 * A directive on line one gates the whole file, and it does so by *being* line
 * one. Pushing it down is the difference between a document only teachers read
 * and a document everybody reads, so it is not something a command that inserts
 * a marker gets to do as a side effect.
 */
function firstWritableLine(editor: Editor): number {
  return isFileLevelDirective(editor.getLine(0)) ? 1 : 0;
}

/**
 * Asks how many columns.
 *
 * It defaults to three: two has a command of its own and does not need to be
 * asked for. Below two there is no side-by-side block to write, so the dialog
 * refuses it; above, there is no bound, because the renderer has none and a
 * person writing six columns knows what they are doing.
 */
class ColumnCountModal extends Modal {
  constructor(
    app: App,
    private readonly onChoose: (columns: number) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Side-by-side columns" });

    const input = contentEl.createEl("input", { type: "number", value: "3" });
    input.min = "2";
    input.style.width = "100%";

    const confirm = () => {
      const columns = Number.parseInt(input.value, 10);
      this.close();
      if (Number.isFinite(columns) && columns >= 2) this.onChoose(columns);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") confirm();
    });
    contentEl.createEl("button", { text: "Insert" }).addEventListener("click", confirm);

    input.focus();
    input.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Writes one restricted section per name, in the order the names were given.
 *
 * The heading goes **inside** the block, and that is not a formatting choice.
 * `removeForbiddenContent` replaces what stands *between* the markers, per
 * reader, and leaves everything outside them for everyone. A heading naming the
 * student above their block would therefore stay on the page for every other
 * student - so a document written to show each of them only their own section
 * would show all of them the names of all the others. Inside the block, a reader
 * who is not addressed sees an empty space.
 *
 * Its level is one below the last heading above the insertion point, so the
 * sections stand underneath whatever chapter they were put in rather than at a
 * level this function picked.
 */
function insertSectionsPerName(editor: Editor, names: string[]) {
  if (names.length === 0) return;

  // A selection means nothing to this command, and `writeLines` replaces what is
  // selected. The sections go where the selection begins and nothing is lost.
  editor.setCursor(editor.getCursor("from"));

  const heading = "#".repeat(headingLevelForSections(editor));
  const lines: string[] = [];
  for (const name of names) {
    if (lines.length > 0) lines.push("");
    lines.push(`@@@ ${name}`, `${heading} ${name}`, "", "@@@");
  }

  // Line 2 of the first section: its heading is written, and what follows is
  // what the person is about to write.
  writeLines(editor, lines, 2);
  reportReservedNames(names);
}

/**
 * Encloses what is selected in a directive built from the given entries.
 *
 * With nothing selected it writes an empty block rather than reaching for the
 * paragraph the cursor happens to be in. `insertFragment` does reach for it, and
 * the difference is what the mistake costs: a fragment marker in the wrong place
 * is visible the next time the deck is opened, while a restriction over text
 * nobody pointed at is invisible to the person who wrote it and shows up as
 * somebody not seeing something they should.
 */
function restrictSelection(editor: Editor, entries: string[]) {
  if (entries.length === 0) return;

  const selection = editor.getSelection();
  const content = selection === "" ? [""] : selection.split("\n");
  const lines = [`@@@ ${entries.join(", ")}`, ...content, "@@@"];
  writeLines(editor, lines, selection === "" ? 1 : lines.length - 1);
}

/** One level below the last heading above the insertion point, and one where there is none. */
function headingLevelForSections(editor: Editor): number {
  const at = editor.getCursor("from").line;
  for (let line = at; line >= 0; line--) {
    const match = headingPattern().exec(editor.getLine(line));
    if (match) return Math.min(match[1].length + 1, 6);
  }
  return 1;
}

/**
 * Says which of the given names the server will read as a role rather than as
 * the person who bears it - and changes none of them.
 *
 * The names are written as they were given: this command inserts what it was
 * handed and decides nothing. But `hasRoles` drops a display name equal to one
 * of the five rather than adding it, so a section addressed to `Students` is
 * addressed to the role and read by every student in the school. Nothing in the
 * document says so, and no marking can: to the plugin an entry naming `teacher`
 * is an entry naming `teacher`, and marking every one of them as a collision
 * would be noise on the most common directive in the corpus.
 *
 * This command is the one place in the plugin that knows a *person* was meant,
 * because it was just handed a list of them. So it is the one place that can say
 * it, and it says it once.
 */
function reportReservedNames(names: string[]) {
  const collisions = names.filter(isReservedName);
  if (collisions.length === 0) return;
  new Notice(
    `The server reads ${collisions.join(", ")} as a role, not as a person. A display name equal ` +
      `to ${NAMES_RESERVED_FOR_ROLES.join(", ")} is dropped instead of being added to a reader's ` +
      `roles, so those sections are shown to everyone holding the role. They were written as you ` +
      `gave them; nothing was changed.`,
    0
  );
}

/**
 * Asks for a list of names, one per line.
 *
 * A text field rather than a picker, because there is no directory to pick from
 * yet - and rather than the selected text or a file in the vault, because the
 * first makes selecting the wrong thing a silent way to generate the wrong
 * document, and the second is a second source of truth beside the directory that
 * is coming. When it comes, this is where the picker goes and nothing else about
 * these commands changes.
 */
class NameListModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly onList: (names: string[]) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: "One name per line. Paste a class list straight in." });

    const input = contentEl.createEl("textarea");
    input.rows = 10;
    input.style.width = "100%";

    const confirm = () => {
      const names = input.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      this.close();
      if (names.length > 0) this.onList(names);
    };

    // Enter belongs to the list; the whole point of the field is more than one
    // line in it.
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) confirm();
    });
    contentEl.createEl("button", { text: "Insert" }).addEventListener("click", confirm);

    input.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}
