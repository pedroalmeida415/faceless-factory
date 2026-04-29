# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```
Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

## Local Effect Source

The Effect v3 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage labels use the canonical mattpocock/skills label names. See `docs/agents/triage-labels.md`.

### Domain docs

Domain docs use a single-context layout with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
