# Contributing

Status: pre-release (V1). The public API contract lives in [SPEC.md](./SPEC.md); changes to it should be
discussed in an issue first.

## Development

```bash
bun install
cp .env.example .env                                  # untracked; set POSTGRES_PASSWORD (below)
perl -pi -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sudo docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis, bound to 127.0.0.1
bun run typecheck && bun test                          # unit + integration (mock Vexa in-process)
```

The real end-to-end path (`bun run test:e2e`) needs the local capture rig; see
[infra/README.md](./infra/README.md).

## Pull requests

- Keep commits small and scoped; explain *why* in the message.
- Add or update tests next to the code you change (`test/unit`, `test/integration`, `test/e2e`).
- Never commit secrets. `.env`, `infra/dstack/.env`, `tmp/` and generated certificates are gitignored;
  `.env.example` files hold placeholders only. Dev credentials under `infra/` are throwaway values for
  the local rig.
- Upstream dependencies vendored under `infra/` (Vexa, docker-jitsi-meet) are pinned in `UPSTREAM_PIN`
  files; bump the pin rather than editing the vendored copy.

## Security

See [SECURITY.md](./SECURITY.md) for private reporting.

## License

By contributing you agree that your contributions are licensed under the
[TinyCloud Open Source License](./LICENSE.md).
