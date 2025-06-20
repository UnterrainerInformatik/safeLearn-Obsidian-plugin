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

## 🔐 Disclaimer
This plugin does not enforce permissions. It is purely visual. All security filtering is expected to be done on your SafeLearn rendering server (e.g., via Node.js and Keycloak).

## 📄 License
[The Unlicense](https://github.com/UnterrainerInformatik/safeLearn-Obsidian-plugin#Unlicense-1-ov-file)