# DiskTree

A native GPUI disk explorer inspired by the supplied DiskTree reference. Its own light slate shell, pastel nested treemap, and compact selection inspector preserve the useful structure without copying the visual design.

<img width="2080" height="1440" alt="image" src="https://github.com/user-attachments/assets/e6b3e4cf-0aab-44ef-8994-f4b2ba2994d9" />

## Reference

Inspired by the two DiskTree screenshots supplied by the user; the original source repository was not supplied. The layout and palette are independently implemented, and there is no affiliation with the reference application. See the [benchmark license terms](../../README.md#license).

## Run

```sh
gpui-shell run -d apps/disktree
```

Starts in your home folder. Enter another absolute path in the location field. Scan progress updates while directory batches run; Cancel stops scheduling more batches. No filesystem links are traversed. Hidden files can be included or excluded, Size switches between allocated disk blocks and apparent byte counts, and Files / Age change area weighting. Age means days since the item's own modification time, not bytes. Directory sizes include descendants and directory metadata; hardlinks count once, while file counts count directory entries. Scan warnings are collapsed by default. Inaccessible entries are excluded and reported.

Click a rectangle to inspect it, use Browse or Enter to enter a folder, and use Back / Forward or Backspace to navigate. Depth controls nesting. Filter matches names and keeps ancestor folders containing matches. The inspector shows size, share, file count, modification date, kind, and actual disk capacity. Worth a look highlights build outputs and cache folders; suggestions are a filename heuristic and require review.

Space marks an item; `c` opens review. Review offers Move to Trash and Delete permanently…. Move to Trash keeps marked items recoverable; Delete permanently… lists the exact paths and requires a separate irreversible confirmation. Permanent deletion validates and stages only those selected items before purging them; any failed purge remains recoverable in app Trash. Restore buttons persist across restarts. Empty app Trash opens a second confirmation listing each item and measured allocated bytes. Only the separate Delete permanently action releases the staged data; it cannot be undone. Hardlinks, snapshots and filesystem compression can reduce actual recovered capacity. Disk free space is read again from `df` after cleanup. Root, home, current scan root and app data are protected; mutations are limited to your home and app data, with canonical parent checks, link-preserving moves and no overwrite. Scan-only access is available outside home. The application requests these explicit manifest capabilities rather than running an installer or shell script.

Keyboard: Space mark, Enter browse, Backspace up, `c` review, `hjkl` select root items, `/` type a filter (Enter/Escape ends filter typing), `[` / `]` depth, `t` metric, `0` reset metric/depth/filter, `r` rescan. Typing inside either native text input does not trigger filesystem shortcuts.

Current platform is Linux with GNU `stat`, `df`, `mv`, `realpath`, `readlink`, `rm`, `du`, and `xdg-open`. `stat` batches preserve arbitrary filenames including line breaks and provide exact allocated block counts, unlike approximate byte-only calculations. Large scans take longer and retain the resulting tree in memory; cancellation finishes an already running small command batch. A changing filesystem can affect scan consistency. The treemap fills during scanning with explicitly labeled partial estimates, publishing at most about once every 300 ms. Incremental ancestor totals count each entry once; small directories share stat subprocesses. Rescanning keeps the preceding result until the first new partial result. Reloading dev cancels scan batches owned by the previous view. The flexible canvas and percentage-based tiles resize with native layout. Moving items into private Trash preserves data and does not release disk space until explicitly emptied. It does not integrate with desktop Trash. Closed-app scan state and marks are not persisted. Native `check` validates materialization but does not prove final paint or mouse/keyboard interaction; no visible window was launched during development.

```sh
mkdir -p "$HOME/.cache/gpui-shell-benchs-test-tmp"
TMPDIR="$HOME/.cache/gpui-shell-benchs-test-tmp" node --test apps/disktree/tests/*.mjs
gpui-shell check -d apps/disktree
```

Space toggles the hovered rectangle, falling back to the selected item. Marked folders and their descendants use an orange tint; holding Space does not repeatedly toggle. Text input keeps normal spaces.

The map uses subtle category gradients. Native 180 ms ease-out transitions keep rectangle position and size continuous across scan updates; marked rectangles switch to their distinct fill immediately. Press `m` with the map focused to turn motion off/on; the preference persists.
