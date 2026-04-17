# Leading Symbol Font Fallback Demo

This example packages a small reproducible DAG focused on the leading-symbol font fallback regression fixed in `src/cli/graph-rendering.ts`.

## What It Contains

- `build-demo.mjs`: creates the demo project and exports PNG/HTML artifacts
- `project/`: generated SQLite-backed research project
- `leading-symbol-font-fallback-demo.png`: exported PNG render
- `leading-symbol-font-fallback-demo.html`: local HTML visualization
- `leading-symbol-font-fallback-demo.summary.json`: export metadata and artifact paths

## What It Tests

- Leading neutral symbols inherit the following strong Latin script: `• English title`
- Leading neutral symbols inherit the following strong CJK script: `- 中文标题`
- Leading mixed-script titles keep explicit script boundaries: `→ Mixed 混排 title`
- Inline neutral punctuation inherits the previous strong script: `English • 中文` and `中文 → English`
- Neutral-only lines fall back to the Latin stack: `• → -`

## Rebuild

```bash
cd /Users/jin/projects/meomeo-dev_deep-research_repo
rm -rf examples/leading-symbol-font-fallback-demo/project
node examples/leading-symbol-font-fallback-demo/build-demo.mjs
```

The script expects the `project/` directory to be absent before rebuilding.
