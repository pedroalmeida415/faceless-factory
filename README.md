# Faceless Factory

Faceless Factory is a visual workspace for building generative media workflows. Connect prompt, list, and asset inputs to image generation nodes, configure a model, and run parts of a workflow independently. The editor previews branch alignment, generated outputs, stale results, and estimated generation cost.

It is for creators and developers who want to compose repeatable image and video pipelines without wiring every generation step by hand. This repository is an actively developed MVP; some roadmap items are still in progress.

## Built with

- Next.js 16, React 19, TypeScript, and Tailwind CSS
- React Flow for the node editor, with tRPC and TanStack Query for typed server communication
- Effect for application and infrastructure workflows
- PostgreSQL with Drizzle ORM, Redis with BullMQ, and S3-compatible object storage
- Better Auth, Stripe, and Google Vertex AI integrations
- Bun for package management and scripts

## Run locally

You need Bun, Docker Compose, and Node.js supported by the installed Next.js version.

1. Install dependencies and create a local environment file:

   ```sh
   bun install
   cp .env.example .env
   ```

2. In `.env`, replace the `replace-*` placeholders with local-only values. Use the same local PostgreSQL password in `POSTGRES_PASSWORD` and `DATABASE_URL`. Set a local `BETTER_AUTH_SECRET` (for example, generate one with `openssl rand -base64 32`). GitHub OAuth and Stripe placeholders satisfy startup configuration but their integrations require valid provider test credentials to use. Google credentials are needed for Vertex AI generation.

3. Start PostgreSQL, Redis, and MinIO:

   ```sh
   docker compose up -d
   ```

4. Create or update the local database schema and start the app:

   ```sh
   bun run db:push
   bun run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

Use made-up content while developing. Do not commit `.env` or put real customer or personal data in fixtures, screenshots, or examples. `.env.example` is a placeholder template and should not contain working credentials.

## Useful commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the development server |
| `bun run build` | Build the production app |
| `bun run start` | Serve a production build |
| `bun run db:generate` | Generate Drizzle migrations from schema changes |
| `bun run db:push` | Apply the current schema to the configured database |
| `bun run check` | Run Biome checks |
| `bun run typecheck` | Run the TypeScript compiler |
| `bun run test` | Run the Bun test suite |
| `bun run storybook` | Start Storybook |

## Project plans

The current product and infrastructure backlog is in [TODO.md](./TODO.md). Domain language and workflow rules are documented in [CONTEXT.md](./CONTEXT.md), with architecture decisions in [docs/adr](./docs/adr/).

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
