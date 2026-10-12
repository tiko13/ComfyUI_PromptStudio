// Only the five bundled Turbo filenames changed. Historical generation
// snapshots remain untouched so their recorded execution remains accurate.
export function currentWorkflowId(value) {
  return String(value || "").replace(
    /(^|[/\\])(\[PS\] - QwenImage21 (?:Create|Edit|RGBA|RGBA Edit|Background Removal)) turbo(?:4|6)\.json(?=$|\0)/,
    "$1$2 turbo8.json",
  );
}
