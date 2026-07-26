/*
 * Runs in CI (.github/workflows/optimize-images.yml) after a push to the
 * deploy branch. For every blog post under content/sections/<section>/, any
 * image the post references that isn't already `<slug>_<n>.webp` gets
 * converted to WebP, renamed, and the post's JSON is rewritten to point at
 * the new filename.
 *
 * Idempotent by design: a second run with nothing left to convert makes no
 * changes and the workflow pushes no commit, so there is no steady-state
 * loop even without GitHub's own protection against GITHUB_TOKEN-triggered
 * re-runs.
 *
 * Ordering: driven by the order images already appear in each post's JSON
 * (top-level `image`, then each section's `images[]` in order) -- that's
 * editorial intent, not just whatever order the filesystem happens to list
 * files in. Any image sitting in the post's folder but not referenced by
 * the JSON (e.g. uploaded but not yet attached to a field) is appended
 * after, alphabetically.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const REPO_ROOT = path.join(__dirname, '..');
const SECTIONS_ROOT = path.join(REPO_ROOT, 'content', 'sections');
const RASTER_EXT_RE = /\.(png|jpe?g|gif)$/i;

function listSections() {
  if (!fs.existsSync(SECTIONS_ROOT)) return [];
  return fs.readdirSync(SECTIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listPostFiles(section) {
  const dir = path.join(SECTIONS_ROOT, section);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.json'))
    .map((f) => ({ slug: f.name.replace(/\.json$/, ''), file: path.join(dir, f.name) }));
}

function canonicalName(slug, index) {
  return `${slug}_${index}.webp`;
}

function isCanonical(filename, slug) {
  const re = new RegExp('^' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_(\\d+)\\.webp$', 'i');
  return re.test(filename);
}

function publicPathToDisk(publicPath) {
  // e.g. "/blogs/my-slug/photo.png" -> "<repo>/public/blogs/my-slug/photo.png"
  return path.join(REPO_ROOT, 'public', publicPath.replace(/^\//, ''));
}

function diskPathToPublic(diskPath) {
  const rel = path.relative(path.join(REPO_ROOT, 'public'), diskPath).split(path.sep).join('/');
  return '/' + rel;
}

/** Collect { path: string[], value: string } for every image reference in a post that lives under its own slug folder. */
function collectImageRefs(entry, section, slug) {
  const refs = [];
  const folderPrefix = `/${section}/${slug}/`;

  if (typeof entry.image === 'string' && entry.image.startsWith(folderPrefix)) {
    refs.push({ path: ['image'], value: entry.image });
  }
  if (Array.isArray(entry.sections)) {
    entry.sections.forEach((sec, si) => {
      if (Array.isArray(sec.images)) {
        sec.images.forEach((img, ii) => {
          if (img && typeof img.src === 'string' && img.src.startsWith(folderPrefix)) {
            refs.push({ path: ['sections', si, 'images', ii, 'src'], value: img.src });
          }
        });
      }
    });
  }
  return refs;
}

function setAtPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) cur = cur[pathArr[i]];
  cur[pathArr[pathArr.length - 1]] = value;
}

async function convertToWebp(srcDisk, destDisk) {
  const ext = path.extname(srcDisk).toLowerCase();
  const image = sharp(srcDisk, { animated: ext === '.gif' });
  await image.webp({ quality: 80 }).toFile(destDisk);
  fs.unlinkSync(srcDisk);
}

async function processPost(section, slug, file) {
  const raw = fs.readFileSync(file, 'utf8');
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    console.warn(`  skip (invalid JSON): ${file}`);
    return { converted: 0, changed: false };
  }

  const folderDisk = path.join(REPO_ROOT, 'public', section, slug);
  if (!fs.existsSync(folderDisk)) return { converted: 0, changed: false };

  const existingFiles = fs.readdirSync(folderDisk);
  let maxIndex = 0;
  existingFiles.forEach((name) => {
    const m = new RegExp('^' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_(\\d+)\\.webp$', 'i').exec(name);
    if (m) maxIndex = Math.max(maxIndex, parseInt(m[1], 10));
  });

  const refs = collectImageRefs(entry, section, slug);
  const referencedBasenames = new Set(refs.map((r) => path.basename(r.value)));
  let changed = false;
  let converted = 0;

  // Referenced images first, in JSON order -- this is editorial intent.
  for (const ref of refs) {
    const basename = path.basename(ref.value);
    if (isCanonical(basename, slug)) continue; // already correct
    const srcDisk = publicPathToDisk(ref.value);
    if (!fs.existsSync(srcDisk)) continue; // reference is stale/broken, leave it alone
    maxIndex += 1;
    const newName = canonicalName(slug, maxIndex);
    const destDisk = path.join(folderDisk, newName);
    if (RASTER_EXT_RE.test(basename)) {
      await convertToWebp(srcDisk, destDisk);
    } else {
      fs.renameSync(srcDisk, destDisk);
    }
    const newPublicPath = diskPathToPublic(destDisk);
    setAtPath(entry, ref.path, newPublicPath);
    changed = true;
    converted += 1;
    console.log(`  ${ref.value} -> ${newPublicPath}`);
  }

  // Orphan files in the folder that no field references -- alphabetical.
  const remaining = fs.readdirSync(folderDisk)
    .filter((name) => !isCanonical(name, slug) && !referencedBasenames.has(name) && (RASTER_EXT_RE.test(name) || /\.webp$/i.test(name)))
    .sort();
  for (const name of remaining) {
    const srcDisk = path.join(folderDisk, name);
    maxIndex += 1;
    const newName = canonicalName(slug, maxIndex);
    const destDisk = path.join(folderDisk, newName);
    if (RASTER_EXT_RE.test(name)) {
      await convertToWebp(srcDisk, destDisk);
    } else {
      fs.renameSync(srcDisk, destDisk);
    }
    converted += 1;
    console.log(`  (unreferenced) ${name} -> ${newName}`);
  }

  if (changed) {
    fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  }

  return { converted, changed };
}

async function main() {
  const sections = listSections();
  let totalConverted = 0;
  let totalChangedFiles = 0;

  for (const section of sections) {
    const posts = listPostFiles(section);
    for (const { slug, file } of posts) {
      console.log(`Checking ${section}/${slug}...`);
      const result = await processPost(section, slug, file);
      totalConverted += result.converted;
      if (result.changed) totalChangedFiles += 1;
    }
  }

  console.log(`\nDone. ${totalConverted} image(s) converted/renamed across ${totalChangedFiles} post(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
