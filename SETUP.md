# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## External

I do use some 3rd-party stuff. Run the `pi install` commands in `README.md`.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "catppuccin-mocha"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.

## Subagent defaults

Models differ per machine, so subagent defaults live in the uncommitted `~/.pi/agent/settings.json`. Every key is optional; anything unset falls back to the parent model (pi) or the CLI's own default (claude, codex):

```json
{
  "subagents": {
    "defaults": {
      "pi": { "model": "provider/model-id", "reasoningEffort": "medium" },
      "claude": { "model": "claude-opus-5-5", "reasoningEffort": "high" },
      "codex": { "model": "gpt-6.1-sol", "reasoningEffort": "high" }
    }
  }
}
```

An invalid entry makes every `subagent_spawn` fail with the offending key until it is fixed; run `/reload` after editing.
