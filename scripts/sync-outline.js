#!/usr/bin/env node

/**
 * Outline Wiki to Hugo/Hextra Sync Script
 *
 * This script synchronizes content from an Outline wiki instance to a Hugo site
 * using the Hextra theme. It fetches collections and documents from Outline's API
 * and converts them to Hugo-compatible markdown files.
 *
 * Usage:
 *   node scripts/sync-outline.js [options]
 *
 * Options:
 *   --collection=NAME  Only sync the specified collection (by name or slug)
 *   --dry-run          Show what would be done without making changes
 *   --verbose          Show detailed output
 *   --clean            Remove existing synced content before syncing
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Configuration
const CONFIG = {
  // Outline API configuration
  outlineUrl: process.env.OUTLINE_URL || "https://rpi.wiki",
  apiKey:
    process.env.OUTLINE_API_KEY ||
    "API KEY HERE",

  // Hugo content directory
  contentDir: path.join(__dirname, "..", "content"),

  // Output directory for synced content (relative to contentDir)
  docsDir: "docs",

  // Sync metadata file
  syncMetadataFile: path.join(__dirname, "..", ".outline-sync-metadata.json"),
};

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes("--dry-run"),
  verbose: args.includes("--verbose"),
  clean: args.includes("--clean"),
  collection: null,
};

// Parse --collection=name or --collection name
const collectionArgIndex = args.findIndex(a => a.startsWith("--collection"));
if (collectionArgIndex !== -1) {
  const arg = args[collectionArgIndex];
  if (arg.includes("=")) {
    options.collection = arg.split("=")[1];
  } else if (args[collectionArgIndex + 1] && !args[collectionArgIndex + 1].startsWith("--")) {
    options.collection = args[collectionArgIndex + 1];
  }
}

// Global document ID to Hugo path mapping
// This is populated during the first pass and used for link resolution
const docIdToPath = new Map();

// Logging utilities
function log(message) {
  console.log(`[sync] ${message}`);
}

function verbose(message) {
  if (options.verbose) {
    console.log(`[sync:verbose] ${message}`);
  }
}

function error(message) {
  console.error(`[sync:error] ${message}`);
}

/**
 * Make an API request to Outline
 */
function outlineApi(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/${endpoint}`, CONFIG.outlineUrl);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const postData = JSON.stringify(body);

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    verbose(`API Request: ${endpoint}`);

    const req = client.request(requestOptions, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok === false) {
            reject(
              new Error(
                `API Error: ${parsed.error || parsed.message || "Unknown error"}`,
              ),
            );
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on("error", (e) => {
      reject(new Error(`Request failed: ${e.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Fetch all collections from Outline
 */
async function fetchCollections() {
  log("Fetching collections...");
  const response = await outlineApi("collections.list", {
    limit: 100,
  });

  verbose(`Found ${response.data.length} collections`);
  return response.data;
}

/**
 * Fetch document structure for a collection
 */
async function fetchCollectionDocuments(collectionId) {
  verbose(`Fetching document structure for collection ${collectionId}...`);
  const response = await outlineApi("collections.documents", {
    id: collectionId,
  });
  return response.data;
}

/**
 * Fetch a single document by ID
 */
async function fetchDocument(documentId) {
  verbose(`Fetching document ${documentId}...`);
  const response = await outlineApi("documents.info", {
    id: documentId,
  });
  return response.data;
}

/**
 * Export a document as markdown
 */
async function exportDocumentMarkdown(documentId) {
  verbose(`Exporting document ${documentId} as markdown...`);
  const response = await outlineApi("documents.export", {
    id: documentId,
  });
  return response.data;
}

/**
 * Slugify a string for use in file paths
 */
function slugify(text, fallback = "untitled") {
  if (!text || !text.trim()) {
    return fallback;
  }

  const slug = text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(/[^\w\-]+/g, "") // Remove all non-word chars
    .replace(/\-\-+/g, "-") // Replace multiple - with single -
    .replace(/^-+/, "") // Trim - from start of text
    .replace(/-+$/, ""); // Trim - from end of text

  return slug || fallback;
}

/**
 * Generate Hugo front matter for a document
 */
function generateFrontMatter(doc, opts = {}) {
  const frontMatter = {
    title: doc.title || "Untitled",
    type: "docs",
  };

  // Add weight for ordering if provided
  if (opts.weight !== undefined) {
    frontMatter.weight = opts.weight;
  }

  // Add sidebar options for folders
  if (opts.isFolder) {
    frontMatter.sidebar = {
      open: false,
    };
  }

  // Add date information
  if (doc.createdAt) {
    frontMatter.date = doc.createdAt;
  }

  if (doc.updatedAt) {
    frontMatter.lastmod = doc.updatedAt;
  }

  // Add Outline metadata for tracking
  frontMatter._outline = {
    id: doc.id,
    updatedAt: doc.updatedAt,
  };

  // Convert to YAML format
  let yaml = "---\n";
  yaml += serializeYaml(frontMatter, 0);
  yaml += "---\n";

  return yaml;
}

/**
 * Serialize an object to YAML format
 */
function serializeYaml(obj, indent = 0) {
  let yaml = "";
  const spaces = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      yaml += `${spaces}${key}:\n`;
      yaml += serializeYaml(value, indent + 1);
    } else if (Array.isArray(value)) {
      yaml += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object") {
          yaml += `${spaces}- \n`;
          yaml += serializeYaml(item, indent + 2);
        } else {
          yaml += `${spaces}- ${item}\n`;
        }
      }
    } else if (
      typeof value === "string" &&
      (value.includes(":") || value.includes("#") || value.includes("\n"))
    ) {
      yaml += `${spaces}${key}: "${value.replace(/"/g, '\\"')}"\n`;
    } else {
      yaml += `${spaces}${key}: ${value}\n`;
    }
  }

  return yaml;
}

/**
 * Extract document ID from Outline URL patterns
 * Outline URLs can be in various formats:
 * - /doc/title-slug-docId
 * - /doc/docId
 * - /s/collection/doc/title-slug-docId
 */
function extractDocIdFromUrl(url) {
  // Pattern 1: UUID at the end of the path (most common)
  const uuidPattern = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\)|$)/i;
  const uuidMatch = url.match(uuidPattern);
  if (uuidMatch) {
    return uuidMatch[1];
  }
  
  // Pattern 2: Short ID format (all caps or mixed)
  const shortIdPattern = /\/doc\/(?:[a-zA-Z0-9-]+-)?([a-zA-Z0-9]{8,})(?:\)|$)/;
  const shortIdMatch = url.match(shortIdPattern);
  if (shortIdMatch) {
    return shortIdMatch[1];
  }
  
  // Pattern 3: Just extract the last segment
  const lastSegmentPattern = /\/doc\/([^\s\)]+)/;
  const lastSegmentMatch = url.match(lastSegmentPattern);
  if (lastSegmentMatch) {
    const segment = lastSegmentMatch[1];
    // If segment contains a dash, the ID is likely after the last dash
    const parts = segment.split('-');
    if (parts.length > 1) {
      return parts[parts.length - 1];
    }
    return segment;
  }
  
  return null;
}

/**
 * Process markdown content from Outline
 * - Fix relative links using the docIdToPath mapping
 * - Handle images
 * - Clean up any Outline-specific syntax
 */
function processMarkdownContent(content, doc) {
  if (!content) return "";

  let processed = content;

  // Remove the title from the content if it starts with an H1 matching the doc title
  if (doc.title) {
    const titlePattern = new RegExp(
      `^#\\s*${escapeRegex(doc.title)}\\s*\\n*`,
      "i",
    );
    processed = processed.replace(titlePattern, "");
  }

  // Fix internal Outline links - convert them to relative Hugo links
  // Pattern matches markdown links like [text](/doc/slug-docId) or [text](https://rpi.wiki/doc/...)
  processed = processed.replace(
    /\]\((?:https?:\/\/[^\/]+)?\/(?:s\/[^\/]+\/)?doc\/([^\s\)]+)\)/g,
    (match, pathPart) => {
      const docId = extractDocIdFromUrl(match);
      
      if (docId && docIdToPath.has(docId)) {
        const hugoPath = docIdToPath.get(docId);
        return `](${hugoPath})`;
      }
      
      // If we can't find the document, keep as external link
      verbose(`Could not resolve internal link for: ${pathPart}`);
      return `](${CONFIG.outlineUrl}/doc/${pathPart})`;
    },
  );

  // Handle Outline attachments/images
  // Outline images are typically served from /api/attachments.redirect
  processed = processed.replace(
    /!\[([^\]]*)\]\((?:https?:\/\/[^\/]+)?\/api\/attachments\.redirect\?id=([a-zA-Z0-9-]+)[^)]*\)/g,
    (match, alt, attachmentId) => {
      // Keep the original URL - images will be served from Outline
      return `![${alt}](${CONFIG.outlineUrl}/api/attachments.redirect?id=${attachmentId})`;
    },
  );

  // Remove standalone backslashes caused by Outline's formatting (often used for spacing)
  // Matches a backslash on its own line, possibly with whitespace
  processed = processed.replace(/^\\\s*$/gm, "");

  // Fix literal \n in headers (e.g. ## \nTitle -> ## Title) so they remain valid headers
  processed = processed.replace(/(^#+\s*)\\n/gm, "$1");
  
  // Fix literal \n in regular text (convert to actual newline)
  processed = processed.replace(/\\n/g, "\n");

  return processed.trim();
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(string) {
  if (!string) return "";
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First pass: Build the document ID to Hugo path mapping
 */
function buildDocumentMapping(node, basePath) {
  // Use a shortened version of the ID as fallback if title is empty
  const fallbackSlug = `doc-${node.id.substring(0, 8)}`;
  const slug = slugify(node.title, fallbackSlug);
  const hasChildren = node.children && node.children.length > 0;

  let hugoPath;
  if (hasChildren) {
    hugoPath = `${basePath}/${slug}/`;
  } else {
    hugoPath = `${basePath}/${slug}/`;
  }

  // Store the mapping
  docIdToPath.set(node.id, hugoPath);
  verbose(`Mapped ${node.id} -> ${hugoPath}`);

  // Process children
  if (hasChildren) {
    for (const child of node.children) {
      buildDocumentMapping(child, `${basePath}/${slug}`);
    }
  }
}

/**
 * Recursively process document structure and create files
 */
async function processDocumentNode(node, parentPath, weight = 0) {
  // Use a shortened version of the ID as fallback if title is empty
  const fallbackSlug = `doc-${node.id.substring(0, 8)}`;
  const slug = slugify(node.title, fallbackSlug);
  const hasChildren = node.children && node.children.length > 0;

  // Fetch the full document
  const doc = await fetchDocument(node.id);

  // Export markdown content
  const markdownContent = await exportDocumentMarkdown(node.id);

  // Generate front matter
  const frontMatter = generateFrontMatter(doc, {
    weight,
    isFolder: hasChildren,
  });

  // Process the content (with link resolution)
  const processedContent = processMarkdownContent(markdownContent, doc);

  // Combine front matter and content
  const fileContent = frontMatter + "\n" + processedContent + "\n";

  let filePath;
  if (hasChildren) {
    // This is a folder/section - create _index.md
    const folderPath = path.join(parentPath, slug);
    filePath = path.join(folderPath, "_index.md");

    if (!options.dryRun) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Process children
    for (let i = 0; i < node.children.length; i++) {
      await processDocumentNode(node.children[i], folderPath, i);
    }
  } else {
    // This is a leaf page
    filePath = path.join(parentPath, `${slug}.md`);
  }

  if (options.dryRun) {
    log(`Would create: ${filePath}`);
  } else {
    fs.writeFileSync(filePath, fileContent, "utf8");
    verbose(`Created: ${filePath}`);
  }

  return { slug, filePath };
}

/**
 * Process a collection and create the folder structure
 */
async function processCollection(collection) {
  log(`Processing collection: ${collection.name}`);

  const collectionSlug = slugify(collection.name);
  
  // If we're syncing rpi-wiki specifically, put it directly in docs root
  // Otherwise preserve collection folder structure
  const isFlattened = options.collection && (collectionSlug === 'rpi-wiki' || collectionSlug === options.collection.toLowerCase());
  
  const collectionPath = isFlattened 
    ? path.join(CONFIG.contentDir, CONFIG.docsDir)
    : path.join(CONFIG.contentDir, CONFIG.docsDir, collectionSlug);

  // Fetch document structure first to build the mapping
  const documentStructure = await fetchCollectionDocuments(collection.id);
  
  // Build the document ID to path mapping (first pass)
  const basePath = isFlattened ? '/docs' : `/docs/${collectionSlug}`;
  if (documentStructure && documentStructure.length > 0) {
    for (const docNode of documentStructure) {
      buildDocumentMapping(docNode, basePath);
    }
  }
  
  log(`Built mapping for ${docIdToPath.size} documents`);

  if (!options.dryRun) {
    fs.mkdirSync(collectionPath, { recursive: true });
  }

  // Process collection description for links
  let description = collection.description || "";
  if (description) {
    // Pass a dummy doc object with empty title so it doesn't try to strip title from H1
    description = processMarkdownContent(description, { title: "" });
  }

  // Create collection index file
  const collectionIndex = `---
title: "${collection.name}"
type: docs
sidebar:
  open: false
_outline:
  collectionId: ${collection.id}
---

${description}
`;

  const indexPath = path.join(collectionPath, "_index.md");

  if (options.dryRun) {
    log(`Would create: ${indexPath}`);
  } else {
    fs.writeFileSync(indexPath, collectionIndex, "utf8");
    verbose(`Created: ${indexPath}`);
  }

  // Process all documents (second pass - now with link resolution)
  if (documentStructure && documentStructure.length > 0) {
    for (let i = 0; i < documentStructure.length; i++) {
      await processDocumentNode(documentStructure[i], collectionPath, i);
    }
  }

  return collectionSlug;
}

/**
 * Clean existing synced content
 */
function cleanSyncedContent() {
  const docsPath = path.join(CONFIG.contentDir, CONFIG.docsDir);

  if (fs.existsSync(docsPath)) {
    log("Cleaning existing synced content...");

    if (!options.dryRun) {
      // Read metadata to find which folders were created by sync
      let metadata = {};
      if (fs.existsSync(CONFIG.syncMetadataFile)) {
        try {
          metadata = JSON.parse(
            fs.readFileSync(CONFIG.syncMetadataFile, "utf8"),
          );
        } catch (e) {
          verbose("Could not read sync metadata file");
        }
      }

      // Remove synced collections
      if (metadata.collections) {
        for (const slug of metadata.collections) {
          const collectionPath = path.join(docsPath, slug);
          if (fs.existsSync(collectionPath)) {
            fs.rmSync(collectionPath, { recursive: true, force: true });
            verbose(`Removed: ${collectionPath}`);
          }
        }
      }
    }
  }
}

/**
 * Save sync metadata
 */
function saveSyncMetadata(data) {
  if (!options.dryRun) {
    fs.writeFileSync(
      CONFIG.syncMetadataFile,
      JSON.stringify(data, null, 2),
      "utf8",
    );
    verbose(`Saved sync metadata to ${CONFIG.syncMetadataFile}`);
  }
}

/**
 * Create the main docs index if it doesn't exist
 */
function ensureDocsIndex() {
  const docsPath = path.join(CONFIG.contentDir, CONFIG.docsDir);
  const indexPath = path.join(docsPath, "_index.md");

  if (!fs.existsSync(indexPath)) {
    const indexContent = `---
title: Documentation
type: docs
---

Welcome to the documentation.
`;

    if (!options.dryRun) {
      fs.mkdirSync(docsPath, { recursive: true });
      fs.writeFileSync(indexPath, indexContent, "utf8");
    }
    log(`Created main docs index: ${indexPath}`);
  }
}

/**
 * Main sync function
 */
async function sync() {
  log("Starting Outline to Hugo sync...");
  log(`Outline URL: ${CONFIG.outlineUrl}`);
  log(`Content directory: ${CONFIG.contentDir}`);

  if (options.dryRun) {
    log("DRY RUN MODE - No changes will be made");
  }

  try {
    // Clean existing content if requested
    if (options.clean) {
      cleanSyncedContent();
    }

    // Ensure docs directory has an index
    ensureDocsIndex();

    // Fetch all collections
    let collections = await fetchCollections();
    log(`Found ${collections.length} collections`);

    // Filter to specific collection if requested
    if (options.collection) {
      const collectionName = options.collection.toLowerCase();
      collections = collections.filter(c => 
        slugify(c.name) === collectionName || 
        c.name.toLowerCase() === collectionName
      );
      if (collections.length === 0) {
        error(`Collection "${options.collection}" not found`);
        process.exit(1);
      }
      log(`Filtering to collection: ${collections[0].name}`);
    }

    // Process each collection
    const syncedCollections = [];
    for (const collection of collections) {
      try {
        const slug = await processCollection(collection);
        syncedCollections.push(slug);
      } catch (e) {
        error(
          `Failed to process collection "${collection.name}": ${e.message}`,
        );
        if (options.verbose) {
          console.error(e.stack);
        }
      }
    }

    // Save sync metadata
    saveSyncMetadata({
      lastSync: new Date().toISOString(),
      collections: syncedCollections,
      outlineUrl: CONFIG.outlineUrl,
      documentMappings: Object.fromEntries(docIdToPath),
    });

    log("Sync completed successfully!");
    log(`Synced ${syncedCollections.length} collections`);
    log(`Mapped ${docIdToPath.size} documents`);
  } catch (e) {
    error(`Sync failed: ${e.message}`);
    if (options.verbose) {
      console.error(e.stack);
    }
    process.exit(1);
  }
}

// Run the sync
sync();
