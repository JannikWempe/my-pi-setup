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
