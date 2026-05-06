# WebFetch Extension for pi

A smart URL content fetcher that pulls clean, readable content from any web page and delivers it exactly where you need it.

## Quick Start

### Install the extension
```bash
pi install git:github.com/John-Dekka/pi-webfetch
```

That's it. Your assistant can now read the web.

## What It Is

WebFetch is an extension for [pi](https://pi.dev) that lets your coding assistant fetch and extract content from any URL on the web. Instead of dealing with messy HTML, ads, navigation bars, and page clutter you get clean, well-formatted content ready to read or analyze.

It started life as the web_fetch tool inside [OpenClaw](https://github.com/openclaw/openclaw). I lifted it, adapted it to work as a standalone pi extension, and here we are. Sometimes the best code is code already written.

Think of it as giving your AI assistant a pair of reading glasses and a highlighter. It can read any webpage and give you just the good stuff.

## How It Works

Using WebFetch is straightforward:

1. **Copy the extension** to your pi extensions folder
2. **Use the tool** in your prompts with any URL
3. **Get clean results** — plain text or markdown, your choice

The extension automatically:

- **Cleans up web pages** - Removes ads, navigation, sidebars, and other noise using Mozilla's Readability technology
- **Handles special sites intelligently** - GitHub repositories, READMEs, issues, and pull requests get special treatment with properly formatted content
- **Falls back gracefully** - If the fancy extraction fails, it still tries simpler methods so you almost always get *something* useful
- **Protects you from huge pages** - Large content is handled safely with truncation that saves the full page for later reading
- **Speaks markdown** - Output comes in clean markdown format that's easy to work with

## Why It's Really Good

### You Actually Get Readable Content

Web pages are designed to sell ads and keep you navigating and not to be read by programs. WebFetch strips all that away. You get the article, the documentation, the content you wanted. Not the page wrapper!

### GitHub Support Is Excellent

Fetching from GitHub isn't just "download the HTML." WebFetch talks directly to the GitHub API:
- Repository READMEs come through clean
- Issues and PRs are formatted as nice markdown with titles, authors, labels, and bodies
- Code files are returned with proper syntax highlighting hints

### It's Resilient

The web is messy. Sites go down, content changes, extraction sometimes fails. WebFetch has multiple fallback strategies so it rarely returns nothing. If one method fails, it tries another. Your workflow keeps moving.

### Large Pages Don't Break Things

When a page is huge, WebFetch truncates gracefully and saves the full content to a file. You can pick up exactly where it left off using the read tool. No re-fetching, no wasted bandwidth, no truncation anxiety.

### It Just Works

No configuration, no API keys, no setup. Drop it in, use it. The default timeouts and sizes handle most real-world pages. The sensible defaults mean less fiddling and more doing.

## Requirements

- [pi](https://pi.dev) coding agent
- Node.js that supports ES modules
- Dependencies: `@mozilla/readability` and `linkedom` (auto-installed)

## License

MIT - Use it, share it, make it better. ♥️
