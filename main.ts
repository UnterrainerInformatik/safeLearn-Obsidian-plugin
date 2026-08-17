import { Plugin } from "obsidian";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Range, Text } from "@codemirror/state";

export default class SafeLearnPlugin extends Plugin {
  async onload() {
    console.log("✅ SafeLearn plugin loaded");

    this.registerEditorExtension(safelearnHighlighter);
    this.registerMarkdownPostProcessor((el) => {
      cleanPreview(el);
    });
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

// ################### The rendered reading view ###################

/**
 * Takes the tags out of rendered output.
 *
 * This is the post-processor Obsidian calls as it renders, and it is the only
 * thing in this plugin that may write into rendered output. Its own repair is
 * `plugin-render-hide-tags`; what it gained here is the recognition rules above,
 * because a second rule for the same tag form is what made the rendered view and
 * the editor disagree about what a fragment is.
 */
function cleanPreview(el: HTMLElement) {
  el.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;

    const text = node.textContent?.trim();
    if (!text) return;

    // An element that holds nothing but tags has nothing left to show.
    if (withoutTags(text).trim() === "") {
      node.addClass("safelearn-hidden");
      return;
    }

    node.childNodes.forEach((child) => {
      if (child.nodeType !== Node.TEXT_NODE) return;

      const original = child.textContent ?? "";
      const remaining = withoutTags(original);
      if (remaining === original) return;

      const span = document.createElement("span");
      span.textContent = remaining;
      child.replaceWith(span);
    });
  });
}

// ################### The blocks a document is made of ###################

type Block = {
  kind: "permission" | "side-by-side";
  from: number;
  to: number;
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
function resolveBlocks(doc: Text): DocumentStructure {
  const blocks: Block[] = [];

  // A first line beginning with `@@@` is the file-level form, which gates the
  // whole file and has no closing marker. The renderer splits that line off the
  // document before it looks for a block at all, so this is what it is by
  // position rather than by what follows it: read as an unclosed block instead,
  // it swallows every marking below it.
  const fileDirective = isFileLevelDirective(doc.line(1).text) ? 1 : null;
  const start = fileDirective === null ? 1 : 2;

  let permissionFrom = -1;
  let sideFrom = -1;
  let separators: number[] = [];

  for (let i = start; i <= doc.lines; i++) {
    const text = doc.line(i).text;

    if (permissionFrom === -1) {
      if (opensPermissionBlock(text)) {
        permissionFrom = i;
        continue;
      }
      // A closing marker with nothing open closes nothing and opens nothing.
    } else if (closesPermissionBlock(text)) {
      blocks.push({ kind: "permission", from: permissionFrom, to: i, separators: [] });
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
      blocks.push({ kind: "side-by-side", from: sideFrom, to: i, separators });
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
    blocks.push({ kind: "permission", from: permissionFrom, to: doc.lines, separators: [] });
  }
  if (sideFrom !== -1) {
    blocks.push({ kind: "side-by-side", from: sideFrom, to: doc.lines, separators });
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

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;

  // What each line carries by virtue of the blocks covering it, for the whole
  // document. Turned into decorations further down, and only where they can
  // actually be seen.
  const lineClasses = new Map<number, string[]>();
  const carries = (line: number, className: string) => {
    const classes = lineClasses.get(line);
    if (classes) classes.push(className);
    else lineClasses.set(line, [className]);
  };

  const { blocks, fileDirective } = resolveBlocks(doc);

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
  for (const block of blocks) {
    if (block.kind === "permission") readDirective(block.from);
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
        // line element at a time, so which side of it a line is on is something
        // the marking has to say - the side-by-side block is drawn the same way
        // for the same reason. It is no new conclusion about the document: the
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

  // Only the lines on screen produce decorations. A rebuild now happens on every
  // cursor move as well as on every keystroke, and there is nothing to gain from
  // constructing decorations for lines the editor has not built an element for.
  const visibleLines = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) visibleLines.add(i);
  }

  const ranges: Range<Decoration>[] = [];
  for (const number of visibleLines) {
    const line = doc.line(number);
    for (const className of lineClasses.get(number) ?? []) {
      ranges.push(Decoration.line({ class: className }).range(line.from));
    }
    for (const { index, length } of fragmentsIn(line.text)) {
      ranges.push(
        Decoration.mark({ class: "fragment-highlight" }).range(line.from + index, line.from + index + length)
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

const safelearnHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Text is not the only thing that changes what has to be marked. The
      // editor builds only the lines around the viewport, so scrolling brings in
      // lines nothing has looked at yet; and in Live Preview a tag is shown as
      // its own characters when the cursor enters it, which is a change in what
      // is on screen with no change to the document at all.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
