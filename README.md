# PropMove

Automatically move notes based on frontmatter properties. **It just works.**

> 💡 **Built with AI** — This plugin is developed and maintained via AI agents.
> I use AI as my primary tool for implementation, issue handling, and maintenance.
> You are free to choose whether to use this plugin based on that.

<a href="https://www.buymeacoffee.com/yffbptmtaa" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-violet.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Features

- **Auto-move on create/update** — watches frontmatter changes and moves notes automatically
- **Multiple property mappings** — define value-to-folder rules per property
- **Smart conflict handling** — appends unique suffixes when targets exist
- **Ignore folders** — exclude template folders from processing
- **Auto folder creation** — creates missing target directories
- **Wiki-link stripping** — `[[Project]]` resolves to clean folder name
- **Autocomplete** — property names and folder paths suggest from your vault
- **Auto-update paths** — mapping folders follow vault renames automatically
- **Match operators** — equals, contains, is-empty, is-not-empty per mapping

## Screenshots

Simple. Manually map specific values:

![PropMove Settings](assets/screenshot.png)

Variable. Use wildcards to create dynamic paths:

![PropMove Settings](assets/screenshot_2.png)

## How It Works

1. Note created or frontmatter changes
2. If in ignored folder → skipped
3. First matching property mapping determines target folder
4. If target exists → numeric suffix appended (configurable)
5. Note moved to destination, folders created if needed

## License

MIT
