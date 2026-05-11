# Rufus

Design audit + implementation subagent for [Claude Code](https://claude.ai/code).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/SunToTheGit/rufus/main/install.sh | bash
```

Then in any Claude Code session, in any project:

```
run rufus
run rufus audit
run rufus implement
```

## What it does

Audits the current project for design and UX debt, picks the top 5 issues
with file paths + line numbers + concrete fixes, optionally implements them,
runs verification, deploys, and writes the changes doc. One pass, one
subagent, no slash commands needed.

Auto-detects the project stack (TypeScript / Expo / Rust / Go / Python /
Supabase edge functions / Netlify). Reads gstack design skills
(`sunny-steve-jobs`, `impeccable`, `ui-ux-pro-max`, `critique`) when
present, falls back to inlined rules otherwise. Auto-installs gstack on
first run if missing.

## Voice

Sharp, direct. Cites file paths and line numbers. Calls out anti-patterns
in its own ship history. Says "the loop is done, pivot" when it is. No
marketing tone in user-facing copy.

See `rufus.md` for the full agent definition.
