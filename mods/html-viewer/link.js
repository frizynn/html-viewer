// A clicked .html or .md link opens as a page in a viewer tab of the clicked
// terminal's space, so it is drawn on the machine that holds the file.
import { run } from "herdr";

// Herdr resolves only a local link's path. For a remote one, the text as
// clicked becomes a path on the terminal's machine: unquoted, a file:// URL's
// path whatever its host, without a :line or #L suffix, and made absolute from
// the terminal's folder, because the viewer would read it from the space's.
export function target(link, cwd) {
  if (link.path) return link.path;
  let s = link.raw.trim().replace(/^(["'`<])(.*)(["'`>])$/s, "$2").trim();
  if (s.startsWith("file:")) {
    try { return decodeURIComponent(new URL(s).pathname); } catch { return s; }
  }
  if (link.line != null) s = s.replace(/(:\d+(-\d+)?(:\d+)?|#L\d+(-L?\d+)?)$/, "");
  if (!/^[/~]/.test(s) && cwd) s = `${cwd}/${s}`;
  return s;
}

export function handleLink({ link, source }) {
  if (link.kind !== "file" || !source.space) return "pass";
  run("tab.new", { space: source.space, mod: "html-viewer",
    props: { space: source.space, machine: source.machine, file: target(link, source.cwd) } });
  return "handled";
}
