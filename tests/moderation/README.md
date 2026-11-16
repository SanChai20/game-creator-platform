# Moderation audit

A labelled corpus of uploads and a local copy of the publish pipeline, to measure how often the automated gates
block a good game (false block) or publish a violator (false approval).

```sh
node tests/moderation/make-corpus.mjs            # generates the copies, templates and art (see corpus/.gitignore)
node tests/moderation/audit.mjs --jobs=2 --out=/tmp/audit.json
node tests/moderation/audit.mjs --only=g-snake,c-memory-reskin --jobs=1
node tests/moderation/one.mjs g-memory           # full browser report of one case
```

- Each case is a folder with the bundle and `case.json`: `expect` (publish or block), `kind`, the `gate` that should
  catch it, `live` (part of the catalogue copies are compared with), `owner`, `copy_of` and the listing.
- The static check, the game Worker, the browser check (Playwright with a software GPU), the originality, is-it-a-game
  and content checks are the platform's own code. Workers AI is called for real when `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_ACCOUNT_API_TOKEN` are set (`NO_AI=1` turns it off).
- The abusive cases are inert stand-ins: they talk to `*.example.invalid`, download dummy bytes and carry no real
  harmful content, only listings that name it.
- Use `--jobs=2` or less: playthrough timings in heavy games slip when several software-GPU browsers share the CPU,
  which the platform's own verifier (one game per browser) does not suffer.
- The fast rule-level tests are in `tests/moderation.mjs` and run with `npm test`.
