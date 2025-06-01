import { Plugin } from "obsidian";
import {
  Decoration,
  DecorationSet,
  ViewPlugin,
  EditorView,
  ViewUpdate
} from "@codemirror/view";
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

    if (
      /^ *@{3} *$/.test(text) ||
      /^ *@{3} +([^\n\s,]+([ ,]+[^\n\s,]+)*)$/.test(text) ||
      /^##fragment$/.test(text) ||
      /^##(side-by-side-(start|end)|separator)$/.test(text)
    ) {
      node.addClass("safelearn-hidden");
      return;
    }

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

const safelearnHighlighter = ViewPlugin.define((view: EditorView) => {
  let decorations = buildDecorations(view);

  const observer = new MutationObserver(() => {
    decorations = buildDecorations(view);
    view.dispatch({ effects: [] });
  });

  observer.observe(view.dom, { attributes: true, attributeFilter: ["class"] });

  return {
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState !== update.state
      ) {
        decorations = buildDecorations(update.view);
      }
    },
    destroy() {
      observer.disconnect();
    },
    decorations
  };
},
{
  decorations: v => v.decorations
});

function buildDecorations(view: EditorView): DecorationSet {
  if (view.dom.classList.contains("cm-preview")) {
    return Decoration.none;
  }
  const doc = view.state.doc;
  const lineCount = doc.lines;
  const decorations: { from: number, to: number, deco: Decoration }[] = [];

  let permissionBlockStart = -1;
  let sideBlockStart = -1;

  for (let i = 1; i <= lineCount; i++) {
    const line = doc.line(i);
    const text = line.text.trim();

    // === Global @@@ Directive in first line ===
    if (i === 1 && /^ *@{3} +[^\s,]+([ ,]+[^\s,]+)* *$/.test(text)) {
      const matchIndex = line.text.indexOf("@@@");
      const from = line.from + matchIndex;
      const to = line.to;

      decorations.push({
        from,
        to,
        deco: Decoration.mark({ class: "permission-global-directive" }),
      });
      continue;
    }

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
        deco: Decoration.mark({ class: "fragment-highlight" }),
      });
    }

    // === @@@ Block ===
    if (permissionBlockStart === -1 && text.startsWith("@@@")) {
      permissionBlockStart = i;
      continue;
    }

    if (permissionBlockStart !== -1 && text === "@@@") {
      for (let j = permissionBlockStart; j <= i; j++) {
        const l = doc.line(j);
        decorations.push({
          from: l.from,
          to: l.from,
          deco: Decoration.mark({ class: "permission-block" }),
        });
      }
      permissionBlockStart = -1;
    }

    // === ##side-by-side blocks ===
    if (sideBlockStart === -1 && text === "##side-by-side-start") {
      sideBlockStart = i;
      continue;
    }

    if (sideBlockStart !== -1 && text === "##side-by-side-end") {
      for (let j = sideBlockStart; j <= i; j++) {
        const l = doc.line(j);
        const cl = j === sideBlockStart ? "side-by-side-start" : j==i ? "side-by-side-end" : "side-by-side-block";
        decorations.push({
          from: l.from,
          to: l.from,
          deco: Decoration.mark({ class: cl }),
        });
      }
      sideBlockStart = -1;
      continue;
    }

    // === ##separator within Side-by-Side ===
    if (sideBlockStart !== -1 && text === "##separator") {
      decorations.push({
        from: line.from,
        to: line.from,
        deco: Decoration.mark({ class: "side-by-side-separator" }),
      });
    }
  }


  decorations.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, deco } of decorations) {
    builder.add(from, to, deco);
  }

  return builder.finish();
}
