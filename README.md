# SafeLearn Plugin for Obsidian

A community plugin for Obsidian that provides visual aids for [SafeLearn](https://github.com/UnterrainerInformatik/safeLearn)-specific Markdown tags.
It enhances the editing experience by adding visual formatting for Reveal.js fragments, role-based permission blocks, and multi-column side-by-side layouts.

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

**A directive is now marked as the list it is.** The server splits the text after `@@@` on commas and reads every entry on its own, and so does the plugin: a directive naming four things carries four markings rather than one, and each says what is true of that entry.

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
| A directive on the **first line** of a document | Gates the whole file and has no closing marker, so it is drawn as a rule the document begins under — not as a block that starts there. |
| An entry carrying a **time window** | Marked apart from a permanent one. The block behind it appears or disappears with nobody editing the document, which is a different promise than a permanent grant. The marking never changes with the clock: a window that has closed looks exactly like one that has not opened. |
| A window the server **cannot read** | Marked as one that will not take effect. `4bhif[yesterday]` is not an error to the server: it drops the window and keeps the entry, so the block is granted permanently to everyone that entry names. Nothing else anywhere reports this. |
| A **view switch** (`#exam`, `#practice`, `#answer`) | Marked apart from a role, because it selects between variants of the document instead of addressing anyone. |
| `#` with **none of those three names** | Marked as the switch that resolves to nothing: the server takes it out of the role test and then nothing decides anything. |
| An entry the server **discards entirely** — `4bhif]`, `4bhif[2026-01-15T08:00:00] extra` | Carries no marking at all, while the entries beside it keep theirs. It addresses nobody. |
| A directive **nothing readable** can be got out of | Marked at the line: the server withholds that text from every reader, an admin included. |

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