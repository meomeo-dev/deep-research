# README Demo DAG

This example packages a reproducible 50-node deep research DAG for repository documentation.

## What It Contains

- `build-demo-dag.mjs`: creates the demo project in four phases and exports artifacts.
- `project/`: the generated SQLite-backed research project.
- `deep-research-demo-dag-50.html`: local HTML visualization of the final graph.
- `deep-research-demo-dag-50.summary.json`: export metadata and artifact paths.
- `../../docs/assets/readme/deep-research-demo-dag-50.png`: README-ready PNG render.

## Theme

The demo studies when multi-step prompting is worth the extra token cost for code generation reliability.

## Rebuild

```bash
cd /Users/luojin/Downloads/meomeo_workspace/deep-research-skill
rm -rf examples/readme-dag-50-demo/project
node examples/readme-dag-50-demo/build-demo-dag.mjs
```

The script expects the `project/` directory to be absent before rebuilding.
# README Demo DAG

This example packages a reproducible 50-node deep research DAG for repository documentation.

## What It Contains

- `build-demo-dag.mjs`: creates the demo project in four phases and exports artifacts.
- `project/`: the generated SQLite-backed research project.
- `deep-research-demo-dag-50.html`: local HTML visualization of the final graph.
- `deep-research-demo-dag-50.summary.json`: export metadata and artifact paths.
- `../../docs/assets/readme/deep-research-demo-dag-50.png`: README-ready PNG render.

## Theme

The demo studies when multi-step prompting is worth the extra token cost for code generation reliability.

## Rebuild

```bash
cd /Users/luojin/Downloads/meomeo_workspace/deep-research-skill
rm -rf examples/readme-dag-50-demo/project
node examples/readme-dag-50-demo/build-demo-dag.mjs
```

The script expects the `project/` directory to be absent before rebuilding.
