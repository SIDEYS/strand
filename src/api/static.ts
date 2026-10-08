import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticFile {
  file: string;
  contentType: string;
  /** Hashed build assets never change under the same URL. */
  immutable: boolean;
}

/**
 * Maps a request path to a file under `root`, or null if there isn't one.
 *
 * A path with no file extension (`/r/demo`) is a client-side route and gets
 * index.html, so deep links and reloads work. A path that looks like an asset
 * but doesn't exist is a real 404 rather than a page, so a broken asset URL
 * fails visibly instead of loading HTML where a script should be.
 *
 * Anything that resolves outside `root` is refused, however it is spelled:
 * the path is decoded and normalised first, and the check is on the resolved
 * result, not on the input.
 */
export async function resolveStaticFile(root: string, urlPath: string): Promise<StaticFile | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, '.' + path.posix.normalize('/' + decoded));
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) return null;

  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  if (await regularFileWithin(candidate, realRoot)) return describe(resolvedRoot, candidate);

  if (path.extname(decoded) !== '') return null;
  const index = path.join(resolvedRoot, 'index.html');
  return (await regularFileWithin(index, realRoot)) ? describe(resolvedRoot, index) : null;
}

/** A regular file whose REAL location is under the root. The lexical check
 * above can't see a symlink inside the root that points outside it. */
async function regularFileWithin(file: string, realRoot: string): Promise<boolean> {
  try {
    const real = await realpath(file);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return false;
    return (await stat(real)).isFile();
  } catch {
    return false;
  }
}

function describe(root: string, file: string): StaticFile {
  const relative = path.relative(root, file).split(path.sep).join('/');
  return {
    file,
    contentType: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    immutable: relative.startsWith('assets/'),
  };
}
