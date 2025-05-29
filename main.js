const { Plugin } = require("obsidian");

module.exports = class SafeLearnPlugin extends Plugin {
  async onload() {
    console.log("✅ SafeLearn Plugin loaded");

    this.observeEditors();
  }

  onunload() {
    console.log("❎ SafeLearn Plugin unloaded");
    // nichts weiter nötig – DOM wird neu aufgebaut bei Wechsel
  }

  observeEditors() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              this.processNode(node);
            }
          }
        }
      }
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        const editors = document.querySelectorAll(".cm-content");
        editors.forEach((el) => {
          this.processNode(el);
          observer.observe(el, { childList: true, subtree: true });
        });
      })
    );
  }

  processNode(container) {
    if (!(container instanceof HTMLElement)) return;

    this.highlightFragments(container);
    this.markPermissionBlocks(container);
    this.convertSideBySide(container);
  }

  highlightFragments(container) {
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => node.nodeValue?.includes("##fragment") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      },
      false
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const parent = node.parentNode;
      if (!parent) continue;

      const parts = node.nodeValue.split("##fragment");
      parent.removeChild(node);

      for (let i = 0; i < parts.length; i++) {
        parent.appendChild(document.createTextNode(parts[i]));
        if (i < parts.length - 1) {
          const span = document.createElement("span");
          span.className = "fragment-highlight";
          span.textContent = "##fragment";
          parent.appendChild(span);
        }
      }
    }
  }

  markPermissionBlocks(container) {
    const nodes = container.querySelectorAll("div");

    nodes.forEach((block) => {
      const text = block.innerText;

      const match = text.match(/^@@@([^\n]+)\n([\s\S]*?)\n@@@$/);
      if (match) {
        const role = match[1].trim();
        const content = match[2].trim();

        const permDiv = document.createElement("div");
        permDiv.className = "permission-block";
        permDiv.innerHTML = `<div class="perm-label">@@@ ${role}</div><div>${content}</div><div class="perm-end">@@@</div>`;
        block.replaceWith(permDiv);
      }
    });
  }

  convertSideBySide(container) {
    const blocks = container.querySelectorAll("div");

    blocks.forEach((block) => {
      const text = block.innerText;
      const match = text.match(/##side-by-side-start([\s\S]*?)##side-by-side-end/);
      if (match) {
        const content = match[1];
        const parts = content.split(/##separator/g);
        const wrapper = document.createElement("div");
        wrapper.className = "side-by-side";
        parts.forEach((part) => {
          const col = document.createElement("div");
          col.innerText = part.trim();
          wrapper.appendChild(col);
        });
        block.replaceWith(wrapper);
      }
    });
  }
};
