const path = require("path");

const wikiLinkRegex = /\[\[(.*?\|.*?)\]\]/g;
const internalLinkRegex = /href="\/(.*?)"/g;
// Markdown-style links to .md files, e.g. [Feedback](../concepts/feedback.md).
// Negative lookbehind excludes image embeds. Group 1 is the link target.
const markdownMdLinkRegex =
  /(?<!\!)\[[^\]]*\]\(\s*([^)\s]+?\.(?:md|markdown))(#[^)\s]*)?\s*\)/gi;
const externalSchemeRegex = /^[a-z][a-z0-9+.-]*:/i;
// Match iframe src for canvas embedded files (internal links only, not external URLs)
// Format: <iframe src="/path/" class="canvas-file-iframe" ...>
// Use non-greedy [^>]*? to avoid over-matching
const iframeSrcRegex = /<iframe[^>]*?src="(\/[^"#]*)"[^>]*?class="canvas-file-iframe"/g;
// Match ```base code blocks to extract links from bases queries
const basesBlockRegex = /```base\n([\s\S]*?)```/g;

let basesEngine = null;
let clearRenderCache = null;
try {
  basesEngine = require("./bases-engine");
  clearRenderCache = require("./basesPlugin").clearRenderCache;
} catch (e) {
  // bases-engine not available, skip bases link extraction
}
const { pickNoteMetadata } = require("./bases-engine/noteMetadata");

/**
 * Resolve a markdown link target to a vault-root-relative path.
 * Returns null for external links or paths escaping the vault root.
 * sourceDir is the vault-relative directory of the linking note ("" for root).
 */
function resolveVaultPath(linkTarget, sourceDir) {
  if (!linkTarget || externalSchemeRegex.test(linkTarget)) {
    return null;
  }
  let decoded = linkTarget;
  try {
    decoded = decodeURI(linkTarget);
  } catch {
    // Keep the raw target if it is not valid percent-encoding
  }
  const resolved = decoded.startsWith("/")
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(path.posix.join(sourceDir || "", decoded));
  if (resolved.startsWith("../") || resolved === "..") {
    return null;
  }
  return resolved;
}

/**
 * Possible vault-root-relative interpretations of a markdown link target,
 * most likely first. Obsidian resolves targets relative to the note, but
 * dataview and Obsidian's "absolute path in vault" link setting emit
 * vault-root paths with no ./ or ../ prefix, so those targets get a
 * vault-root candidate as fallback.
 */
function vaultPathCandidates(linkTarget, sourceDir) {
  const noteRelative = resolveVaultPath(linkTarget, sourceDir);
  const candidates = noteRelative ? [noteRelative] : [];
  if (
    linkTarget &&
    !linkTarget.startsWith("/") &&
    !linkTarget.startsWith("./") &&
    !linkTarget.startsWith("../")
  ) {
    const vaultRoot = resolveVaultPath(linkTarget, "");
    if (vaultRoot && !candidates.includes(vaultRoot)) {
      candidates.push(vaultRoot);
    }
  }
  return candidates;
}

/**
 * Extract markdown-style links to .md files, resolved against the source
 * note's vault path and stripped of extension/fragment so they match the
 * stem URLs used by the graph. Ambiguous targets yield every candidate
 * interpretation; the graph drops the ones that match no note.
 */
function extractMarkdownLinks(content, sourcePath) {
  const links = [];
  const sourceDir = path.posix.dirname(sourcePath || "");
  let match;
  markdownMdLinkRegex.lastIndex = 0;
  while ((match = markdownMdLinkRegex.exec(content)) !== null) {
    for (const resolved of vaultPathCandidates(
      match[1],
      sourceDir === "." ? "" : sourceDir,
    )) {
      links.push(resolved.replace(/\.(md|markdown)$/i, ""));
    }
  }
  return links;
}

/**
 * Rewrite relative .md hrefs in rendered HTML to their resolved permalinks.
 * resolveAnchor(vaultPathCandidates, fragment, originalHref) receives the
 * candidate interpretations (most likely first) and returns an attributes
 * object ({ href, ... }) or null to leave the anchor untouched.
 */
function convertMdHrefs(html, sourceDir, resolveAnchor) {
  // (?:[^>]*?\s)? requires href to start the tag or follow whitespace, so
  // attributes like data-href (dataviewjs anchors) are never rewritten.
  return html.replace(
    /(<a\s(?:[^>]*?\s)?href=")([^"]+)("[^>]*>)/gi,
    (fullMatch, before, href, after) => {
      const [target, ...fragmentParts] = href.split("#");
      const fragment = fragmentParts.length ? `#${fragmentParts.join("#")}` : "";
      if (
        !/\.(md|markdown)$/i.test(target) ||
        target.startsWith("/") ||
        externalSchemeRegex.test(target)
      ) {
        return fullMatch;
      }
      const candidates = vaultPathCandidates(target, sourceDir);
      if (!candidates.length) {
        return fullMatch;
      }
      const attrs = resolveAnchor(candidates, fragment, href);
      if (!attrs || !attrs.href) {
        return fullMatch;
      }
      return `${before}${attrs.href}${fragment}${after}`;
    },
  );
}

function extractLinks(content, sourcePath) {
  // Extract iframe sources for canvas embeds
  const iframeLinks = [];
  let match;
  while ((match = iframeSrcRegex.exec(content)) !== null) {
    // match[1] is the captured path like "/notes/some-page/"
    iframeLinks.push(match[1]);
  }
  // Reset regex lastIndex for next use
  iframeSrcRegex.lastIndex = 0;

  return [
    ...(content.match(wikiLinkRegex) || []).map(
      (link) =>
        link
          .slice(2, -2)
          .split("|")[0]
          .replace(/\.(md|markdown)\s?$/i, "")
          .replace("\\", "")
          .trim()
          .split("#")[0]
    ),
    ...(content.match(internalLinkRegex) || []).map(
      (link) =>
        link
          .slice(6, -1)
          .split("|")[0]
          // Don't strip .canvas - canvas URLs actually include it
          .replace(/\.(md|markdown)\s?$/i, "")
          .replace("\\", "")
          .trim()
          .split("#")[0]
    ),
    ...iframeLinks,
    ...(sourcePath ? extractMarkdownLinks(content, sourcePath) : []),
  ];
}

// Cache for bases query results, keyed by YAML content.
// Built once per build, shared across all notes.
const basesQueryCache = new Map();

/**
 * Extract outbound links from ```base code blocks by running the query
 * against the notes collection and collecting the URLs of matched notes.
 * Results are cached so identical queries and repeated calls are fast.
 */
function extractBasesLinks(content, basesNotes) {
  if (!basesEngine) return [];

  const links = [];
  let match;
  basesBlockRegex.lastIndex = 0;
  while ((match = basesBlockRegex.exec(content)) !== null) {
    const yamlContent = match[1];

    if (!basesQueryCache.has(yamlContent)) {
      try {
        const result = basesEngine.executeBaseQuery(yamlContent, basesNotes);
        const urls = [];
        for (const view of result.views) {
          for (const row of view.rows) {
            if (row.url) urls.push(row.url);
          }
        }
        basesQueryCache.set(yamlContent, urls);
      } catch (e) {
        basesQueryCache.set(yamlContent, []);
      }
    }

    links.push(...basesQueryCache.get(yamlContent));
  }
  return links;
}

// getGraph is called from eleventyComputed, i.e. once per rendered page, but
// its result only depends on the note collection. Recomputing it per page made
// the build O(notes²). Cache the in-flight promise keyed on the collection
// array itself: each build (including watch-mode rebuilds) creates a fresh
// collections array, so the cache self-invalidates and old entries get GC'd.
const graphCache = new WeakMap();

function getGraph(data) {
  const notes = data.collections.note;
  if (!notes) {
    return computeGraph(data);
  }
  let cached = graphCache.get(notes);
  if (!cached) {
    cached = computeGraph(data);
    graphCache.set(notes, cached);
  }
  return cached;
}

async function computeGraph(data) {
  let nodes = {};
  let links = [];
  let stemURLs = {};
  let homeAlias = "/";

  const notes = data.collections.note || [];

  // Clear caches from any previous build (e.g. --watch mode)
  basesQueryCache.clear();
  if (clearRenderCache) clearRenderCache();

  // --- Pass 1: Read content, extract wikilinks/internal links, build nodes ---
  const noteContents = [];
  for (let idx = 0; idx < notes.length; idx++) {
    const v = notes[idx];
    let fpath = v.filePathStem.replace("/notes/", "");
    let parts = fpath.split("/");
    let group = "none";
    if (parts.length >= 3) {
      group = parts[parts.length - 2];
    }

    const templateContent = await v.template.read();
    const content = templateContent?.content || "";
    noteContents.push(content);

    nodes[v.url] = {
      id: idx,
      title: v.data.title || v.fileSlug,
      url: v.url,
      folderPath: fpath.split("/").slice(0, -1).join("/"),
      group,
      home:
        v.data["dg-home"] ||
        (v.data.tags && v.data.tags.indexOf("gardenEntry") > -1) ||
        false,
      outBound: extractLinks(content, fpath),
      neighbors: new Set(),
      backLinks: new Set(),
      noteIcon: v.data.noteIcon || process.env.NOTE_ICON_DEFAULT,
      hide: v.data.hide || v.data.hideInGraph || false,
      private: v.data.hide || false,
    };
    stemURLs[fpath] = v.url;
    if (
      v.data["dg-home"] ||
      (v.data.tags && v.data.tags.indexOf("gardenEntry") > -1)
    ) {
      homeAlias = v.url;
    }
  }

  // --- Pass 2: Resolve outbound links and compute backlinks ---
  Object.values(nodes).forEach((node) => {
    let outBound = new Set();
    node.outBound.forEach((olink) => {
      let link = (stemURLs[olink] || olink).split("#")[0];
      outBound.add(link);
    });
    node.outBound = Array.from(outBound);
    node.outBound.forEach((link) => {
      let n = nodes[link];
      if (n) {
        n.neighbors.add(node.url);
        n.backLinks.add(node.url);
        node.neighbors.add(n.url);
        links.push({ source: node.id, target: n.id });
      }
    });
  });

  // Convert Sets to Arrays
  Object.keys(nodes).map((k) => {
    nodes[k].neighbors = Array.from(nodes[k].neighbors);
    nodes[k].backLinks = Array.from(nodes[k].backLinks);
    nodes[k].size = nodes[k].neighbors.length;
  });

  // --- Pass 3: Build basesNotes with links/backlinks, then extract bases links ---
  // Now that we know all links and backlinks, inject them into the notes
  // so bases queries can access file.links and file.backlinks.
  const urlToNode = nodes;
  const basesNotes = notes.map((item) => {
    const url = (urlToNode[item.url] || {});
    return {
      path: item.filePathStem.replace("/notes/", ""),
      url: item.url,
      metadata: pickNoteMetadata(item.data),
      fileSlug: item.fileSlug,
      // Inject computed link data for bases queries
      _links: url.outBound || [],
      _backlinks: url.backLinks || [],
    };
  });

  // Extract bases links and add them as additional outbound links
  for (let idx = 0; idx < notes.length; idx++) {
    const v = notes[idx];
    const content = noteContents[idx];
    const basesLinks = extractBasesLinks(content, basesNotes);
    if (basesLinks.length > 0) {
      const node = nodes[v.url];
      for (const blink of basesLinks) {
        if (!node.outBound.includes(blink)) {
          node.outBound.push(blink);
          let n = nodes[blink];
          if (n) {
            if (!n.backLinks.includes(v.url)) n.backLinks.push(v.url);
            if (!n.neighbors.includes(v.url)) n.neighbors.push(v.url);
            if (!node.neighbors.includes(blink)) node.neighbors.push(blink);
            links.push({ source: node.id, target: n.id });
          }
        }
      }
      node.size = node.neighbors.length;
    }
  }

  // Add virtual folder nodes to the graph only. No notes or Markdown files are modified.
  // Every visible note links to its direct parent folder; folders link to their
  // parent folder. This mirrors folder structure as implicit graph mentions.
  const visibleNotesForFolders = notes
    .filter((item) => nodes[item.url] && !nodes[item.url].hide)
    .map((item) => ({
      item,
      path: item.filePathStem.replace("/notes/", "").split("/").filter(Boolean),
    }));
  const folderRecords = new Map();

  for (const entry of visibleNotesForFolders) {
    const folderParts = entry.path.slice(0, -1);
    for (let depth = 1; depth <= folderParts.length; depth++) {
      const folderPath = folderParts.slice(0, depth).join("/");
      if (!folderRecords.has(folderPath)) {
        folderRecords.set(folderPath, {
          path: folderPath,
          parentPath: folderParts.slice(0, depth - 1).join("/"),
          representativeUrl: entry.item.url,
        });
      }
    }
  }

  if (folderRecords.size > 0) {
    let nextGraphId = notes.length;
    const folderNodeKeys = new Map();
    const rootFolderKey = "__folder__/";
    const representativeUrl =
      visibleNotesForFolders.length > 0 ? visibleNotesForFolders[0].item.url : "/";

    nodes[rootFolderKey] = {
      id: nextGraphId++,
      title: "/",
      url: representativeUrl,
      folder: true,
      folderRoot: true,
      folderPath: "",
      group: "none",
      home: false,
      outBound: [],
      neighbors: [],
      backLinks: [],
      noteIcon: null,
      hide: false,
      private: false,
      size: 0,
    };
    folderNodeKeys.set("", rootFolderKey);

    const sortedFolders = [...folderRecords.values()].sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length ||
        a.path.localeCompare(b.path, undefined, { sensitivity: "base" })
    );

    for (const folder of sortedFolders) {
      const key = `__folder__/${folder.path}/`;
      folderNodeKeys.set(folder.path, key);
      nodes[key] = {
        id: nextGraphId++,
        title: folder.path.split("/").pop(),
        url: folder.representativeUrl,
        folder: true,
        folderPath: folder.path,
        group: folder.parentPath || "none",
        home: false,
        outBound: [],
        neighbors: [],
        backLinks: [],
        noteIcon: null,
        hide: false,
        private: false,
        size: 0,
      };
    }

    // Build tree edges (root -> top-level folder -> nested folder).
    for (const folder of sortedFolders) {
      const parentKey = folder.parentPath
        ? folderNodeKeys.get(folder.parentPath)
        : rootFolderKey;
      const childKey = folderNodeKeys.get(folder.path);
      if (parentKey && childKey) {
        links.push({ source: nodes[parentKey].id, target: nodes[childKey].id });
      }
    }

    // Attach each note to its immediate folder. Notes in the vault root attach
    // directly to the root folder so the whole hierarchy remains connected.
    for (const entry of visibleNotesForFolders) {
      const folderPath = entry.path.slice(0, -1).join("/");
      const folderKey = folderPath
        ? folderNodeKeys.get(folderPath)
        : rootFolderKey;
      if (folderKey && nodes[entry.item.url]) {
        links.push({
          source: nodes[folderKey].id,
          target: nodes[entry.item.url].id,
        });
      }
    }
  }

  // Store enriched basesNotes for the markdown-it plugin to use
  exports._basesNotesWithLinks = basesNotes;

  return {
    homeAlias,
    nodes,
    links,
  };
}

exports.wikiLinkRegex = wikiLinkRegex;
exports.internalLinkRegex = internalLinkRegex;
exports.extractLinks = extractLinks;
exports.resolveVaultPath = resolveVaultPath;
exports.convertMdHrefs = convertMdHrefs;
exports.getGraph = getGraph;
exports._basesNotesWithLinks = null;
