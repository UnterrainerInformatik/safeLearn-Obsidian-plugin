/**
 * Obsidian Plugin: SafeLearn Plugin
 * Provides visual and structural enhancements for SafeLearn-specific tags.
 * Compatible with plain JavaScript use (no bundler required).
 */

module.exports = class SafeLearnPlugin extends Plugin {
  async onload() {
    console.log("✅ SafeLearn Plugin loaded");
    this.registerEvent(this.app.workspace.on("layout-change", () => this.processAll()));
  }

  onunload() {
    console.log("❎ SafeLearn Plugin unloaded");
    document.querySelectorAll(".fragment-highlight, .permission-block, .side-by-side").forEach(el => {
      el.classList.remove("fragment-highlight", "permission-block", "side-by-side");
    });
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
};
