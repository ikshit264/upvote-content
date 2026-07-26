/*
 * Regenerates index.json at every folder level under content/sections/,
 * recursively (arbitrary depth -- a folder can contain both subfolders and
 * posts, matching how the CMS lets you nest pages like a drive).
 *
 * Each index.json = { path, generatedAt, folders: [names], posts: [summaries] }
 * -- metadata only, never full post content, so any consumer (the live app,
 * another service, an AI agent) can fetch one small file per folder instead
 * of every post file individually.
 *
 * No dependencies -- plain Node, so this repo doesn't need a package.json/
 * npm install step at all.
 *
 * Idempotent: run twice with nothing changed and it writes nothing (JSON is
 * re-serialized deterministically), so the workflow's "commit if changed"
 * step naturally makes this safe against a rebuild loop, same pattern as
 * upvote's scripts/optimize-blog-images.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'content', 'sections');

function walk(dir, relPath) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const folders = [];
  const posts = [];

  for (const entry of entries) {
    if (entry.name === 'index.json' || entry.name === '.gitkeep.json') continue;

    if (entry.isDirectory()) {
      folders.push(entry.name);
      walk(path.join(dir, entry.name), [...relPath, entry.name]);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const data = JSON.parse(raw);
        if (data.draft) continue;
        posts.push({
          slug: entry.name.replace(/\.json$/, ''),
          title: data.title ?? '',
          description: data.description ?? '',
          image: data.image ?? '',
          imageAlt: data.imageAlt ?? undefined,
          date: data.date ?? '',
          author: data.author ?? '',
          category: data.category ?? '',
        });
      } catch (err) {
        console.warn(`Skipping invalid JSON: ${path.join(dir, entry.name)} (${err.message})`);
      }
    }
  }

  folders.sort();
  posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Only bump generatedAt (and touch the file at all) if folders/posts
  // actually changed -- otherwise every run diffs on timestamp alone and
  // the workflow commits on every push even when nothing real changed.
  const indexPath = path.join(dir, 'index.json');
  let previous = null;
  if (fs.existsSync(indexPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch {
      previous = null;
    }
  }

  const contentUnchanged =
    previous &&
    JSON.stringify(previous.folders) === JSON.stringify(folders) &&
    JSON.stringify(previous.posts) === JSON.stringify(posts);

  if (contentUnchanged) return;

  const index = {
    path: relPath.join('/'),
    generatedAt: new Date().toISOString(),
    folders,
    posts,
  };

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
}

if (!fs.existsSync(ROOT)) {
  console.log('content/sections does not exist yet -- nothing to index.');
  process.exit(0);
}

walk(ROOT, []);
console.log('Regenerated index.json at every folder level under content/sections/.');
