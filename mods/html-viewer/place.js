// Where a viewer pane lives: the machine its files are on and the folder it lists.
// Herdr gives a mod pane only the props it was opened with, never its own pane or
// tab, so whoever opens the viewer names the space (`props.space`); a remote space's
// id carries its machine ("rise-l/sp…"), so that holds even before the machine's
// layout has loaded. Opened without one, a copy starts the first time it shows,
// which makes the shown space its own.
export const machineOfId = (id) => (id?.includes("/") ? id.slice(0, id.indexOf("/")) : null);

export function placeOf(p, spaces) {
  const id = p?.space ?? spaces.find((s) => s.active)?.id ?? null;
  const space = spaces.find((s) => s.id === id);
  return {
    space: id,
    machine: p && "machine" in p ? p.machine ?? null : space ? space.machine : machineOfId(id),
    folder: space?.folder || null,
  };
}
