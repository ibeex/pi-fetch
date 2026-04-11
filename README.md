# pi-fetch

Installable pi package that adds a `/fetch` slash command.

`/fetch` retrieves web content and injects it into pi's session context so the next prompt can use it.

## Features

- `/fetch <url>` only
- uses `jina` for normal public URLs and `raw` for localhost, private-network, and other likely local URLs
- retries Jina once with auth on 401/429/auth-required style responses
- loads Jina API key from `JINA_API_KEY`, `JINA_API_TOKEN`, or `pass api/jina`
- supports site-specific cleanup before truncation
- currently cleans Hacker News item pages so the model sees story metadata + comment text instead of repetitive UI noise
- shows a live footer status while fetching
- shows a visible fetch result row in chat; expand it with `Ctrl+O` to inspect what was captured
- truncates fetched content before injecting it into context
- when truncation happens, only the first `PI_FETCH_MAX_CONTEXT_CHARS` chars are added to context and the full fetched response is saved to a temp file
- default fetch context limit is `28000` chars, roughly `~7k` tokens for normal English text
- stores fetched content as a hidden custom session message, so it is available to the model without cluttering chat

## Install

Because this repo now has a `package.json` with a `pi` manifest, you can install it as a pi package.

### Install globally

```bash
pi install /absolute/path/to/pi-fetch
```

### Install into another project

From the target project directory:

```bash
pi install /absolute/path/to/pi-fetch -l
```

Then start pi in that project, or run:

```text
/reload
```

## Quick test without installing

From outside this repo:

```bash
pi -e /absolute/path/to/pi-fetch
```

If you test from inside this repo and already have another copy of `pi-fetch` auto-loaded, disable extension auto-discovery to avoid duplicate `/fetch` commands:

```bash
pi --no-extensions -e .
```

Or load the raw extension file directly:

```bash
pi --no-extensions -e ./index.ts
```

## Usage

```text
/fetch https://example.com/docs
/fetch http://localhost:3000/health
```

After `/fetch`, ask a normal question in the next prompt, for example:

```text
/fetch https://example.com/docs
What are the main points from that page?
```

In interactive mode, `/fetch` also shows:

- a temporary footer spinner while the request is running
- a visible result row after completion
- a short collapsed preview of the captured content
- expandable details with `Ctrl+O`, including the exact content that was injected into context

## Jina auth

Lookup order:

1. `JINA_API_KEY`
2. `JINA_API_TOKEN`
3. `pass api/jina`

Example:

```bash
pass insert api/jina
```

## Optional env vars

- `PI_FETCH_TIMEOUT_MS` default `30000`
- `PI_FETCH_MAX_CONTEXT_CHARS` default `28000` (roughly `~7k` tokens)
- `PI_FETCH_JINA_PASS_PATH` default `api/jina`

## Notes

- This is intentionally slash-command based, not an LLM tool.
- `/fetch` adds context for the next prompt; it does not automatically ask the model a follow-up question.
- `PI_FETCH_MAX_CONTEXT_CHARS` only affects fetched-page context from this extension.
- `truncated` means the fetched response was larger than `PI_FETCH_MAX_CONTEXT_CHARS`, so only the first chunk was injected into model context.
- If truncated, the visible result row shows how many chars were kept vs omitted, and expanded details show the temp file path for the full response.
- The visible fetch result row is filtered out of model context; only the hidden fetched-content message is sent to the model.
- Jina reader is used only for public web URLs. Localhost, private-network, and other likely local URLs use raw fetch automatically.
