import { Plugin } from "obsidian";
import { Decoration, DecorationSet, ViewPlugin, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export default class SafeLearnPlugin extends Plugin {
  async onload() {
    console.log("✅ SafeLearn Plugin geladen");

    this.registerEditorExtension(safelearnHighlighter);
    this.registerMarkdownPostProcessor((el) => {
      cleanPreview(el);
    });
  }
}

function cleanPreview(el: HTMLElement) {
  el.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;

    const text = node.textContent?.trim();
    if (!text) return;

    // Check for @@@ blocks, ##fragment, and ##side-by-side blocks
    if (
      /^ *@{3} *$/.test(text) ||
      /^ *@{3} +([^\s,]+([ ,]+[^\s,]+)*)$/.test(text) ||
      /^##fragment$/.test(text) ||
      /^##(side-by-side-(start|end)|separator)$/.test(text)
    ) {
      node.addClass("safelearn-hidden");
      return;
    }

    // Remove @@@ blocks, ##fragment, and ##side-by-side blocks from text nodes
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        let changed = false;
        let newText = child.textContent ?? "";

        const replacePatterns: RegExp[] = [
          /@@@(?: +[^\s,]+([ ,]+[^\s,]+)*)?/g,
          /##fragment(?![\w-])/gi,
          /##(side-by-side-(start|end)|separator)/gi
        ];

        for (const pattern of replacePatterns) {
          if (pattern.test(newText)) {
            newText = newText.replace(pattern, "");
            changed = true;
          }
        }

        if (changed) {
          const span = document.createElement("span");
          span.textContent = newText;
          child.replaceWith(span);
        }
      }
    });
  });
}

const safelearnHighlighter = ViewPlugin.fromClass(class {
  decorations;

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);
    this.cleanupPreview();
  }

  update(update: { docChanged: boolean, view: EditorView }) {
    if (update.docChanged) {
      this.decorations = this.buildDecorations(update.view);
      this.cleanupPreview();
    }
  }

  buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const lineCount = doc.lines;
  const isPreview = view.dom.classList.contains("cm-preview");

  const decorations: { from: number, to: number, deco: Decoration }[] = [];

  let permissionBlockStart = -1;
  let sideBlockStart = -1;

  for (let i = 1; i <= lineCount; i++) {
    const line = doc.line(i);
    const text = line.text.trim();

    // === ##fragment ===
    let fragIndex = line.text.indexOf("##fragment ");
    if (fragIndex === -1) {
      fragIndex = line.text.indexOf("##fragment");
      // only if the line ends with this "##fragment" without any trailing text
      if (fragIndex !== -1 && line.text.slice(fragIndex + "##fragment".length).trim() !== "") {
        fragIndex = -1;
      }
    }
    if (fragIndex !== -1) {
      const from = line.from + fragIndex;
      const to = from + "##fragment ".length;
      decorations.push({
        from,
        to,
        deco: isPreview
          ? Decoration.replace({})
          : Decoration.mark({ class: "fragment-highlight" }),
      });
    }

    // === @@@ Block ===
    if (permissionBlockStart === -1 && text.startsWith("@@@")) {
      permissionBlockStart = i;
      if (isPreview) {
        const from = line.from + line.text.indexOf("@@@");
        const to = from + "@@@".length;
        decorations.push({ from, to, deco: Decoration.replace({}) });
      }
      continue;
    }

    if (permissionBlockStart !== -1 && text === "@@@") {
      if (isPreview) {
        const from = line.from;
        const to = from + "@@@".length;
        decorations.push({ from, to, deco: Decoration.replace({}) });
      } else {
        for (let j = permissionBlockStart; j <= i; j++) {
          const l = doc.line(j);
          decorations.push({
            from: l.from,
            to: l.from,
            deco: Decoration.line({ class: "permission-block" }),
          });
        }
      }
      permissionBlockStart = -1;
    }

    // === ##side-by-side blocks ===
    if (sideBlockStart === -1 && text === "##side-by-side-start") {
      sideBlockStart = i;
      if (isPreview) {
        const from = line.from;
        const to = from + text.length;
        decorations.push({ from, to, deco: Decoration.replace({}) });
      }
      continue;
    }

    if (sideBlockStart !== -1 && text === "##side-by-side-end") {
      if (isPreview) {
        const from = line.from;
        const to = from + text.length;
        decorations.push({ from, to, deco: Decoration.replace({}) });
      } else {
        for (let j = sideBlockStart; j <= i; j++) {
          const l = doc.line(j);
          const cl = j === sideBlockStart ? "side-by-side-start" : j==i ? "side-by-side-end" : "side-by-side-block";
          decorations.push({
            from: l.from,
            to: l.from,
            deco: Decoration.line({ class: cl }),
          });
        }
      }
      sideBlockStart = -1;
      continue;
    }

    // === ##separator within Side-by-Side ===
    if (sideBlockStart !== -1 && text === "##separator") {
      if (isPreview) {
        const from = line.from;
        const to = from + text.length;
        decorations.push({ from, to, deco: Decoration.replace({}) });
      } else {
        decorations.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: "side-by-side-separator" }),
        });
      }
    }
  }


  decorations.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, deco } of decorations) {
    builder.add(from, to, deco);
  }

  return builder.finish();
}

  cleanupPreview() {
    requestAnimationFrame(() => {
      document.querySelectorAll(".markdown-preview-view").forEach((el) => {
        cleanPreview(el as HTMLElement);
      });
    });
  }
}, {
  decorations: v => v.decorations
});
