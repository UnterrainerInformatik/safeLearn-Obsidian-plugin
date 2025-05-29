/**
 * Obsidian Plugin: SafeLearn Plugin
 * Provides visual and structural enhancements for SafeLearn-specific tags.
 * Compatible with plain JavaScript use (no bundler required).
 */

class SafeLearnPlugin extends Plugin {
  async onload() {
    this.addStyles();
    this.registerDomEvent(document, "DOMContentLoaded", () => {
      this.processAll();
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.processAll())
    );
  }

  onunload() {
    document.querySelectorAll(".fragment-highlight, .permission-block, .side-by-side").forEach(el => {
      el.classList.remove("fragment-highlight", "permission-block", "side-by-side");
    });
  }

  addStyles() {
    const style = document.createElement("style");
    style.id = "safelearn-style";
    style.textContent = `
      .fragment-highlight {
        background-color: var(--fragment-bg);
        color: var(--fragment-fg);
        border: 2px solid var(--fragment-border);
        border-radius: 8px;
        padding: 2px 6px;
        margin: 1px;
        display: inline-block;
        font-weight: 500;
      }
      .fragment-highlight::before {
        content: "🔀 ";
        opacity: 0.6;
      }
      .permission-block {
        background-color: var(--permission-bg, #eef7ff);
        border-left: 4px solid var(--permission-border, #3399ff);
        padding: 4px 8px;
        margin: 8px 0;
      }
      .permission-block .perm-label,
      .permission-block .perm-end {
        font-family: monospace;
        font-size: 0.8em;
        background: #ddeeff;
        color: #225577;
        padding: 2px 4px;
        border-radius: 4px;
        display: inline-block;
        margin-bottom: 4px;
      }
      .side-by-side {
        display: flex;
        gap: 20px;
        margin: 1em 0;
        border: 1px dashed #bbb;
        padding: 8px;
      }
      .side-by-side > div {
        flex: 1;
        padding: 0 10px;
        border-left: 2px dashed #ccc;
      }
    `;
    document.head.appendChild(style);
  }

  processAll() {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view.previewMode?.renderer) {
        const container = view.previewMode.containerEl;
        this.highlightFragments(container);
        this.markPermissionBlocks(container);
        this.convertSideBySide(container);
      }
    }
  }

  highlightFragments(container) {
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          return node.nodeValue?.match(/\s*##fragment\s*/)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      },
      false
    );

    const toHighlight = [];
    while (walker.nextNode()) {
      toHighlight.push(walker.currentNode);
    }

    for (const node of toHighlight) {
      const span = document.createElement("span");
      span.className = "fragment-highlight";
      span.textContent = node.nodeValue;
      node.parentNode?.replaceChild(span, node);
    }
  }

  markPermissionBlocks(container) {
    const blocks = container.innerHTML.match(/@@@[^@\n]+[\s\S]*?@@@/g);
    if (!blocks) return;
    for (const block of blocks) {
      const match = block.match(/^@@@([^\n]+)\n([\s\S]*?)\n@@@$/);
      if (!match) continue;
      const role = match[1].trim();
      const content = match[2].trim();
      const div = document.createElement("div");
      div.className = "permission-block";
      div.innerHTML = `<div class="perm-label">@@@ ${role}</div><div>${content}</div><div class="perm-end">@@@</div>`;
      container.innerHTML = container.innerHTML.replace(block, div.outerHTML);
    }
  }

  convertSideBySide(container) {
    const pattern = /##side-by-side-start([\s\S]*?)##side-by-side-end/g;
    container.innerHTML = container.innerHTML.replace(pattern, (match, content) => {
      const parts = content.split(/##separator/g);
      const columns = parts.map(col => `<div>${col.trim()}</div>`).join('');
      return `<div class="side-by-side">${columns}</div>`;
    });
  }
}

module.exports = SafeLearnPlugin;
