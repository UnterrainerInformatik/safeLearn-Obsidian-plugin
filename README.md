# SafeLearn Plugin for Obsidian

A community plugin for Obsidian that provides visual aids for [SafeLearn](https://github.com/UnterrainerInformatik/safeLearn)-specific Markdown tags.
It enhances the editing experience by adding visual formatting for Reveal.js fragments, role-based permission blocks, and multi-column side-by-side layouts.

A SafeLearn tag is an instruction to the rendering server, not text anyone is meant to read. So the plugin takes the tags out of the way and puts what they mean in their place: a restricted block carries its directive as a heading, the way a table carries its header row. In the reading view the tags are gone entirely and side-by-side content is shown as the columns the server will make of it. In the editor the directive line stands as that heading while you are writing elsewhere, and as its own characters the moment the cursor is in it — the document itself is never touched.

[SafeLearn](https://github.com/UnterrainerInformatik/safeLearn) is an open-source tool for teachers that want to write their learning-materials using Markdown and want to hide those behind a user-login fed by the schools AD or with their own Keycloak instance.
[SafeLearn](https://github.com/UnterrainerInformatik/safeLearn) is a Node-server that is securely publishing your learning materials along with some custom tags, rendering to responsive HTML and Reveal.js and some permission-related stuff to distinguish between pupil-view and teacher-view.
For further details and installation instructions visit the git-repo [here](https://github.com/UnterrainerInformatik/safeLearn).

---

[![GitHub Repo](https://img.shields.io/badge/GitHub-safeLearn--Obsidian--plugin-181717?style=for-the-badge&logo=github)](https://github.com/UnterrainerInformatik/safeLearn-Obsidian-plugin)

## ✨ Features

### 🔹 Fragment Support (`##fragment`)
Marks content blocks that should appear incrementally in Reveal.js slides.

**Example:**
```markdown
This is visible immediately.

##fragment
This will appear as a fragment.

##fragment
- Step 1
- Step 2
```

**What counts as a fragment marker changed, and with it what gets highlighted.** The rule is now the rendering server's own — `##fragment` followed by whitespace or the end of the line, matched case-sensitively, every occurrence in a line rather than the first. It no longer has to stand alone on its line, so `- ##fragment two` is highlighted where it was not before; and `##FRAGMENT` and `##fragment.` are no longer highlighted, because the server does not act on them either. If you had learned the old behavior, this is the change you will notice: the highlight now marks what the server will act on, and nothing else. The highlight also covers the tag alone — the space after it is no longer part of it.

### 🔹 Permission Blocks (`@@@ role`)
Visually wraps blocks meant for specific roles (like teacher, 4bhif, etc.) to make them clearly distinguishable while editing.
**Example:**
```markdown
@@@ teacher
This block is for teachers only.
@@@
```

**A directive is read as the list it is.** The server splits the text after `@@@` on commas and reads every entry on its own, and so does the plugin: a directive naming four things is four things rather than one, and each is shown as what is true of that entry.

**And the directive line is shown as the heading of the block it opens.** In the reading view always; in the editor while the cursor is elsewhere. Put the cursor in the line — or run a selection across it — and its own characters are back and editable. Nothing is written into your file to make that happen: the characters that appear are the ones that were always there.

A time window is reproduced exactly as you wrote it. The plugin will not turn `4bhif[2026-08-01T00:00:00 to 2026-08-20T00:00:00]` into "1–20 August", because that would claim a reading of it — and the server throws away windows that a readable restatement makes look sound.

```markdown
@@@ teacher                                     the whole file, if this is line 1
@@@ 4bhif, teacher[2026-01-15T08:00:00]         one permanent entry, one that starts on a date
@@@ 4bhif[to 2026-01-15T08:00:00]               until a moment
@@@ 4bhif[2026-01-15T08:00:00 to 2026-01-15T12:00:00]
@@@ #exam, #practice, #answer                   variants of the document, not an audience
```

What you can see at a glance, without reading a single timestamp:

| Form | Shown as |
| --- | --- |
| A directive on the **first line** of a document | Gates the whole file and has no closing marker, so it is drawn in the same frame every block gets with its lower edge left off. The open side says by itself that what it governs does not end. |
| An entry carrying a **time window** | Marked apart from a permanent one. The block behind it appears or disappears with nobody editing the document, which is a different promise than a permanent grant. The marking never changes with the clock: a window that has closed looks exactly like one that has not opened. |
| A window the server **cannot read** | Marked as one that will not take effect. `4bhif[yesterday]` is not an error to the server: it drops the window and keeps the entry, so the block is granted permanently to everyone that entry names. Nothing else anywhere reports this. |
| A **view switch** (`#exam`, `#practice`, `#answer`) | Marked apart from a role, because it selects between variants of the document instead of addressing anyone. |
| `#` with **none of those three names** | Marked as the switch that resolves to nothing: the server takes it out of the role test and then nothing decides anything. |
| An entry the server **discards entirely** — `4bhif]`, `4bhif[2026-01-15T08:00:00] extra` | In the line, it carries no marking at all while the entries beside it keep theirs. In the heading it is shown struck through, because there the characters are not on the page to be told apart by what they lack — and leaving it out would hide from you that you wrote something the server throws away. |
| A directive **nothing readable** can be got out of | Its heading says that no reader sees the block — not a name, which would claim the opposite, and not nothing, which would be the one line that disappears without a trace. The server withholds that text from every reader, an admin included. |

The plugin still recognizes no more than the server does. What is marked is what the server will act on — the rules are taken from the server's own parser and are held against it by a check in the SafeLearn repository that runs both over the same directives.

### 🔹 Side-by-Side Columns (##side-by-side-start, ##separator)
Creates multi-column layouts for wide Reveal.js slides.

**Example:**
```markdown
##side-by-side-start
Left side content.
##separator
Right side content.
##side-by-side-end
```

In the editor the block is drawn as the region it is. In the reading view it is rebuilt as columns, split where you split it — letting the markers vanish and the content run on underneath would leave the reading view saying nothing about the page the server produces, which is what it is for. The column widths are not Reveal's and are not meant to be.

`##fragment` is a different case: it selects when content appears in a presentation and says nothing about the document as a document, so the reading view drops it without leaving anything in its place. That a fragment stands there is shown in the editor.

## ⌨️ Writing the tags instead of typing them

Every command below is in the command palette and in the editor's right-click menu, out of one list — a command cannot be in one and missing from the other.

| Command | What it writes |
| --- | --- |
| **Insert side-by-side block** | Two columns, asking nothing. The normal case. |
| **Insert side-by-side block with a chosen number of columns** | Asks how many, defaulting to three. Two has its own command; fewer than two is not a side-by-side block and is refused. |
| **Insert fragment marker** | `##fragment` on a line of its own above the block the cursor is in — above the whole paragraph, not above the line you happen to be on, which would split the paragraph in two. |
| **Insert a restricted section for each name** | Paste a class list, one name per line. You get one `@@@ <name>` … `@@@` block per person, in that order, each with a heading and a line to write in. |
| **Restrict the selection to named readers** | Wraps what you selected in a directive built from the names you give. With nothing selected it writes an empty restricted block rather than reaching for the paragraph you happen to be standing in. |

With text selected, a side-by-side command **encloses it whole** and writes no separator into it. If you selected several paragraphs you do not want them divided at a place the command guessed, so the separators go after your content, where they are a line to move rather than a division to undo. The cursor is left in the empty column, which is the part of the block that is waiting for you.

Each marker is written on a line of its own, and an insertion made in the middle of a line begins on a new one. That is not cosmetic: a marker sharing a line with text is one this plugin does not mark, and the block boundary the server reads then falls inside your sentence.

### Two things about generated sections

**The heading goes inside the block, and it has to.** SafeLearn removes what stands *between* the markers, per reader, and leaves everything outside them for everybody. A heading naming the student above their block would stay on the page for every other student — so a document written so that each of them sees only their own section would show all of them the names of all the others. Inside the block, a reader who is not addressed sees nothing at all. Its level is one below the last heading above where you inserted, so the sections sit under the chapter you put them in.

**Five names are not names.** `admin`, `teacher`, `teachers`, `student` and `students` are reserved: SafeLearn drops a display name equal to one of them instead of adding it to that reader's roles. A section for a student whose display name is `Students` is therefore addressed to the *role*, and every student in the school reads it. The command writes the name exactly as you gave it and corrects nothing — but it tells you which of your names that happened to, once, right after it wrote them. Nothing in the document itself can say it.

## 🛠️ Installation
Clone or download this repository.

Copy the plugin folder into your Obsidian vault's .obsidian/plugins/ directory.

Enable the plugin in Obsidian's settings.

## 📦 Compatibility
Obsidian v0.15.0 or later

No external dependencies

## 🧪 Verification
The checks for this plugin live in the [SafeLearn](https://github.com/UnterrainerInformatik/safeLearn) repository rather than here, because they are driven from the Markdown corpus that repository ships. From a SafeLearn checkout:

```bash
npm run test:obsidian
```

It builds this plugin, assembles a throwaway vault out of that corpus, starts a real Obsidian and reports what the plugin did to the document. It needs no login and starts no server. `SAFELEARN_TEST_PLUGIN_DIR` points it at this checkout; `docs-testing.md` over there describes the rest.

## 🔐 Disclaimer
This plugin does not enforce permissions. It is purely visual. All security filtering is expected to be done on your SafeLearn rendering server (e.g., via Node.js and Keycloak).

## 📄 License
[The Unlicense](https://github.com/UnterrainerInformatik/safeLearn-Obsidian-plugin#Unlicense-1-ov-file)