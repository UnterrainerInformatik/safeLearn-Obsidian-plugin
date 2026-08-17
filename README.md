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