# Local Dataset Directory

Generated HEALPix tile pyramids live here during local development, but they are
not committed to git. A generated dataset normally has this shape:

```text
public/datasets/<dataset-id>/
  manifest.json
  layers/<layer-id>/o<order>/f<face>/x<x>/y<y>.bin
```

Use `public/datasets/index.example.json` as the selector index shape. The
generation commands in the repository create/update `public/datasets/index.json`
for local use.
