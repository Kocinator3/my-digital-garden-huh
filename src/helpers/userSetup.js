const HIGHLIGHT_EMOJI = new Map([
  ["🔴", "red"],
  ["🔵", "blue"],
  ["🟢", "green"],
  ["🟡", "yellow"],
  ["🟣", "purple"],
  ["🟠", "orange"],
  ["🟤", "brown"],
]);

function userMarkdownSetup(md) {
  // Turn ==🔴text== into a colored <mark> while dropping the marker emoji.
  // This runs after Markdown inline parsing, so it works with nested formatting
  // such as ==🔴**bold text**== as well.
  md.core.ruler.push("colored_highlights", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline" || !token.children) continue;

      const children = token.children;
      for (let i = 0; i < children.length; i++) {
        const open = children[i];
        if (open.type !== "mark_open") continue;

        let closeIndex = i + 1;
        while (closeIndex < children.length && children[closeIndex].type !== "mark_close") {
          closeIndex++;
        }

        for (let j = i + 1; j < closeIndex; j++) {
          const child = children[j];
          if (child.type !== "text") continue;

          const marker = [...HIGHLIGHT_EMOJI.keys()].find((emoji) =>
            child.content.startsWith(emoji)
          );
          if (!marker) break;

          child.content = child.content.slice(marker.length).replace(/^\\s+/, "");
          open.attrJoin("class", `highlight-${HIGHLIGHT_EMOJI.get(marker)}`);
          break;
        }
      }
    }
  });
}

function userEleventySetup(eleventyConfig) {
  // Add site-specific Eleventy setup here.
}

exports.userMarkdownSetup = userMarkdownSetup;
exports.userEleventySetup = userEleventySetup;
