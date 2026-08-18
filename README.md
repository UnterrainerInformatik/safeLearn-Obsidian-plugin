# SafeLearn Formatter for Obsidian

Shows what [SafeLearn](https://github.com/UnterrainerInformatik/safeLearn) will do with your document while you write it.

SafeLearn is an open-source server that publishes a teacher's Markdown behind a school login. It reads a few tags of its own — who may read a block, what appears step by step in a presentation, what stands in columns. Those tags are instructions to the server, not text anyone is meant to read. This plugin takes them out of the way and puts what they *mean* in their place. **It never changes your file.**

[![GitHub Repo](https://img.shields.io/badge/GitHub-safeLearn--Obsidian--plugin-181717?style=for-the-badge&logo=github)](https://github.com/UnterrainerInformatik/safeLearn-Obsidian-plugin)

## Install

Settings → **Community plugins** → **Browse** → search for *SafeLearn Formatter* → **Install**, then **Enable**.

Nothing to configure to use the tags below. The directory features further down are opt-in and need a safeLearn instance; everything else works with no settings, no account and no network.

## Write the tags from the menu

Right-click in the editor and open **SafeLearn**. The same five are in the command palette, under *SafeLearn Formatter*.

![The editor's context menu](assets/menu.png)

| Command | What it writes |
| --- | --- |
| **Side-by-side block** | Two columns. |
| **Side-by-side, n columns…** | Asks how many, defaults to three. |
| **Fragment marker** | `##fragment` above the block the cursor is in. |
| **Restricted section per name…** | One restricted block per name — paste a class list. |
| **Restrict selection…** | Wraps the selection in a directive. |

With text selected, a side-by-side command encloses it whole and puts the separator after it. Every marker lands on a line of its own.

## Restricted blocks — `@@@`

`@@@ teacher` opens a block only that reader sees, `@@@` on its own closes it. The directive line stands as the block's heading, and every entry in it is shown as what it *is*:

![Restricted blocks in the editor](assets/permission-blocks.png)

| Marking | Meaning |
| --- | --- |
| Plain chip | A permanent grant. |
| Dashed chip, stopwatch | Carries a time window — the block appears or disappears with nobody editing it. It never changes with the clock: a window that has closed looks like one that has not opened. |
| Red chip, warning | A window SafeLearn **cannot read**. It drops the window and keeps the entry, so the block is granted permanently. Nothing else anywhere tells you. |
| Italic chip, arrows | A view switch (`#exam`, `#practice`, `#answer`) — a variant of the document, not an audience. |
| Struck through | An entry SafeLearn discards entirely. |

Windows are reproduced exactly as you wrote them, never restated in words — a readable restatement would make a window sound that the server throws away.

**Put the cursor in the line and the characters are back**, editable, while the other blocks keep their headings:

![The directive line with the cursor in it](assets/permission-editing.png)

A directive on the **first line** gates the whole file. It has no closing marker, so its frame is drawn with the lower edge left off:

![A whole-file directive](assets/whole-file.png)

Reading view: the tags are gone, the headings remain.

![Restricted blocks in the reading view](assets/permission-reading.png)

### A section per student

*Restricted section per name…* takes a pasted class list and writes one block per person, each with a heading **inside** the block — a heading above it would show every student the names of all the others.

![The class list dialog](assets/name-list.png)

![The sections it writes](assets/per-name-result.png)

Five names are reserved (`admin`, `teacher`, `teachers`, `student`, `students`): SafeLearn reads them as *roles*, so a section for a student called `Students` is read by the whole school. The command writes your names unchanged and tells you when one of them was such a name.

### Picking names from the directory

*Restricted section per name…* and *Restrict selection…* both open the same dialog, and where a safeLearn instance is configured and you are logged in, that dialog gains a search field and a class dropdown above the text area. Typing there searches the school directory; picking a result adds it as a new line, exactly as if you had typed it. Typing or pasting a list still works exactly as before, before or after using the picker, and stays the *only* way to name someone the directory has no entry for — a guest, or a student not yet enrolled.

With no instance configured, or with one configured but not logged in, this dialog is unchanged: no search field, no network activity.

## Directory settings and login

Open under Settings → **SafeLearn Formatter**.

| Setting | What it's for |
| --- | --- |
| **safeLearn instance URL** | Your school's safeLearn server. Empty by default — everything below stays off until it is set. |
| **Keycloak URL** / **Realm** | The identity provider your instance authenticates against. Both default to the project's shared identity provider and only need changing for a self-hosted Keycloak. |
| **Log in** | Opens your realm's own login page in your system browser. No password is ever typed into Obsidian — the plugin only ever sees the token Keycloak hands back afterward. |
| **Log out** | Discards that token. |

Logging in also enables **List classes** in the command palette — a read-only, dismiss-when-read notice of every class-like value currently in the directory. (The server has no separate notion of "class" from any other role or group it tracks, so this is a best-effort reading of the same data the picker above uses, not an authoritative class list.)

### Setting up the login (for whoever runs the safeLearn instance)

Logging in needs a Keycloak client that does not exist by default. In the `safeLearn` realm, create a **public** client (this project's own convention names it `safelearn-plugin`) with:

* Standard Flow enabled, PKCE (S256) required
* Direct Access Grants **off** — no password grant
* No client secret
* Valid Redirect URIs: `obsidian://safelearn-formatter-auth`
* No client roles of its own — what a login is allowed to do comes from the roles already on that person's Keycloak account, the same way the safeLearn server itself checks them

This is a one-time setup step for the person administering the Keycloak realm, not something the plugin or a person using it can do. Nobody using only the tags earlier in this document needs it.

## Fragments — `##fragment`

Content that appears one step at a time in a Reveal.js presentation. The tag is shown as an icon, and is its own characters again with the cursor in it.

![Fragment markers in the editor](assets/fragment.png)

## Columns — `##side-by-side-start`

The block is drawn as the region it is while you write, and rebuilt as the columns the server makes of it when you read. (The widths are not Reveal's and are not meant to be.)

![A side-by-side block in the editor](assets/side-by-side-editor.png)

![The same block in the reading view](assets/side-by-side-reading.png)

## Good to know

* **Obsidian 1.5.7 or later.** No external dependencies, desktop and mobile.
* **The plugin enforces nothing.** It is purely visual — every permission is decided by your SafeLearn server.
* **It marks exactly what the server acts on**, no more: the rules are taken from SafeLearn's own parser, and a check in the [SafeLearn repository](https://github.com/UnterrainerInformatik/safeLearn) runs both over the same directives. From a SafeLearn checkout: `npm run test:obsidian`.

## License

[The Unlicense](https://github.com/UnterrainerInformatik/safeLearn-Obsidian-plugin#Unlicense-1-ov-file)
