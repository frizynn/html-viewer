// The start screen's lists. No Herdr imports, so it runs under node's tests too.

export const RECENT_MAX = 8;

const split = (path) => {
  const i = path.lastIndexOf("/");
  return { dir: i === -1 ? "" : path.slice(0, i), name: path.slice(i + 1) };
};

// A typed path rather than a search: something a file name never starts with.
export const looksLikePath = (text) => /^(\/|~|\.\.?\/|file:\/\/|["'`])/.test(text.trim());

// The files under root that match the query, grouped by folder (root's own first),
// in name order. The query matches anywhere in the path relative to root.
export function groups(files, root, query = "") {
  const q = query.trim().toLowerCase(), byDir = new Map();
  for (const path of files) {
    const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    if (q && !rel.toLowerCase().includes(q)) continue;
    const { dir, name } = split(rel);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ path, name });
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, items]) => ({ folder, files: items.sort((x, y) => x.name.localeCompare(y.name)) }));
}

// Recently opened files, newest first, one entry per machine and path.
export function addRecent(list, { machine, path }, max = RECENT_MAX) {
  const rest = (list ?? []).filter((r) => !(r.machine === machine && r.path === path));
  return [{ machine, path }, ...rest].slice(0, max);
}

export const recentHere = (list, machine, query = "") => {
  const q = query.trim().toLowerCase();
  return (list ?? []).filter((r) => r.machine === machine && (!q || r.path.toLowerCase().includes(q))).map((r) => ({ path: r.path, ...split(r.path) }));
};
