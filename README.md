# Faceless Factory MVP

Minimal Weavy-style workflow builder on Next.js. Current scope:

- `Prompt` node
- `Image` upload node
- `Video` upload node
- `Image Iterator` node
- `Image Generator` node wired to Vertex AI `gemini-3-pro-image-preview`
- `Video Generator` node wired to Vertex AI `veo-3.1-generate-001`
- local upload persistence and generated asset serving
- browser-local graph autosave

## Run

```bash
bun install
bun run dev
```

Open `http://localhost:3000`.

## Vertex AI setup

Required:

- `GOOGLE_CLOUD_PROJECT`
- authentication via one of:
  - `gcloud auth application-default login`
  - `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`
  - `GOOGLE_SERVICE_ACCOUNT_JSON`
  - `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`

Optional:

- `GOOGLE_CLOUD_LOCATION_IMAGE` defaults to `global`
- `GOOGLE_CLOUD_LOCATION_VIDEO` defaults to `us-central1`
- `GOOGLE_CLOUD_LOCATION` shared fallback for non-global models

Example:

```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION_IMAGE=global
GOOGLE_CLOUD_LOCATION_VIDEO=us-central1
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

## How the MVP works

1. Upload source media into image/video/image-iterator nodes.
2. Connect a prompt node into one or both generator nodes.
3. Connect optional image or iterator outputs into the generators.
4. Run a single generator from the node, or use the left sidebar to run all generators.
5. Outputs are written to `.data/workflow-assets/` and served back through `/api/assets/...`.

## Notes

- `Image Iterator -> Image Generator` fans out one image generation request per input image.
- `Image Iterator -> Video Generator` fans out one Veo request per input image.
- This is a local/stateful MVP. Uploaded and generated assets are stored on disk, not object storage.
- Existing auth/db scaffolding remains in the repo, but the workflow UI does not depend on it.
