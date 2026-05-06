/**
 * WebFetch Extension for pi
 * 
 * Fetches content from URLs and returns clean markdown - extracting main content from
 * HTML pages while removing navigation, ads, sidebars, and other noise.
 * 
 * Features:
 * - Uses @mozilla/readability for clean content extraction
 * - Special handling for GitHub (raw API for READMEs, issues, PRs, files)
 * - Falls back to basic HTML parsing if readability fails
 * 
 * Usage:
 * 1. Copy to ~/.pi/agent/extensions/webfetch.ts or .pi/extensions/webfetch.ts
 * 2. Use the webfetch tool in your prompts
 */

import type { ExtensionAPI, TruncationResult } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "fs";

// ============
// Configuration
// ============

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30 * 1000;
const MAX_TIMEOUT = 120 * 1000;

// ============
// Types
// ============

interface WebFetchDetails {
	url: string;
	finalUrl?: string;
	title?: string;
	extractor: string;
	timeout: number;
	contentLength?: number;
	truncation?: TruncationResult;
	contentType?: string;
}

// ============
// Linkedom + Readability imports (lazy loaded)
// ============

type ParseHtmlFn = (html: string) => { document: Document };
type ReadabilityConstructor = new (
	document: Document,
	options: { charThreshold: number },
) => { parse: () => { content?: string; textContent?: string | null; title?: string | null } | null };

let readabilityDepsPromise: Promise<{ parseHTML: ParseHtmlFn; Readability: ReadabilityConstructor }> | undefined;

async function loadReadabilityDeps(): Promise<{ parseHTML: ParseHtmlFn; Readability: ReadabilityConstructor }> {
	if (!readabilityDepsPromise) {
		readabilityDepsPromise = Promise.all([
			import("linkedom") as Promise<{ parseHTML: ParseHtmlFn }>,
			import("@mozilla/readability") as Promise<{ Readability: ReadabilityConstructor }>,
		]).then(([linkedom, readability]) => ({
			parseHTML: linkedom.parseHTML,
			Readability: readability.Readability,
		}));
	}
	return readabilityDepsPromise;
}

// ============
// Content Extraction
// ============

/**
 * Extract clean content from HTML using Readability
 */
async function extractWithReadability(
	html: string,
	url: string,
	extractMode: "markdown" | "text",
): Promise<{ text: string; title?: string } | null> {
	try {
		const { parseHTML, Readability } = await loadReadabilityDeps();
		const { document } = parseHTML(html);
		
		// Set baseURI for relative link resolution (best effort)
		try {
			(document as { baseURI?: string }).baseURI = url;
		} catch {
			// Best effort
		}

		const reader = new Readability(document, { charThreshold: 0 });
		const parsed = reader.parse();
		
		if (!parsed?.content) {
			return null;
		}

		const title = parsed.title || undefined;
		
		if (extractMode === "text") {
			const text = normalizeWhitespace(stripInvisible(parsed.textContent ?? ""));
			return text ? { text, title } : null;
		}

		// Convert content HTML to markdown
		const rendered = htmlToMarkdown(parsed.content);
		const text = stripInvisibleUnicode(rendered.text);
		return text ? { text, title: title ?? rendered.title } : null;
	} catch {
		return null;
	}
}

/**
 * Fallback: basic HTML to markdown extraction
 */
function extractBasicHtml(html: string, extractMode: "markdown" | "text"): { text: string; title?: string } | null {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;

	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

	// Convert links
	text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
		const label = normalizeWhitespace(stripTags(body));
		if (!label) return href;
		return `[${label}](${href})`;
	});

	// Convert headers
	text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
		const prefix = "#".repeat(Math.max(1, Math.min(6, parseInt(level, 10))));
		const label = normalizeWhitespace(stripTags(body));
		return `\n${prefix} ${label}\n`;
	});

	// Convert list items
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
		const label = normalizeWhitespace(stripTags(body));
		return label ? `\n- ${label}` : "";
	});

	// Break tags
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");

	// Strip remaining tags
	text = stripTags(text);
	text = normalizeWhitespace(text);

	if (extractMode === "text") {
		const textOnly = markdownToText(text);
		return textOnly ? { text: textOnly, title } : null;
	}

	return text ? { text, title } : null;
}

// ============
// GitHub Special Handling
// ============

interface GitHubRepoInfo {
	owner: string;
	repo: string;
	path: string;
	isRaw: boolean;
}

// Module-level regex patterns for GitHub URL parsing
const GITHUB_URL_PATTERNS = [
	/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/[^/]+(?:\/(.+))?|\/blob\/[^/]+\/(.+)|\/raw\/[^/]+\/(.+)|\/(issues|pulls)\/\d+)?$/,
];

/**
 * Parse GitHub URL to extract repo info
 */
function parseGitHubUrl(url: string): GitHubRepoInfo | null {
	// Match patterns like:
	// https://github.com/owner/repo
	// https://github.com/owner/repo/tree/main
	// https://github.com/owner/repo/blob/main/README.md
	// https://github.com/owner/repo/issues/1
	// https://github.com/owner/repo/pulls/1
	// https://github.com/owner/repo/raw/main/README.md
	for (const pattern of GITHUB_URL_PATTERNS) {
		const match = url.match(pattern);
		if (match) {
			return {
				owner: match[1],
				repo: match[2],
				path: match[3] || "",
				isRaw: url.includes("/raw/"),
			};
		}
	}
	return null;
}

/**
 * Fetch content from GitHub using raw API
 */
async function fetchGitHubContent(url: string): Promise<string | null> {
	const parsed = parseGitHubUrl(url);
	if (!parsed) return null;

	const { owner, repo, path } = parsed;

	// For tree/repo root, fetch README
	if (!path || path === "") {
		// Try to get the default branch first, then README
		try {
			const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
				headers: {
					"Accept": "application/vnd.github.v3+json",
					"User-Agent": "pi-coding-agent",
				},
			});
			if (!repoResp.ok) return null;
			const repoData = await repoResp.json();
			const defaultBranch = repoData.default_branch || "main";

			// Try README.md in root
			const readmeResp = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/readme`,
				{
					headers: {
						"Accept": "application/vnd.github.v3.raw+json",
						"User-Agent": "pi-coding-agent",
					},
				}
			);
			if (readmeResp.ok) {
				return await readmeResp.text();
			}
		} catch {
			return null;
		}
		return null;
	}

	// For specific issues/PRs
	if (url.includes("/issues/")) {
		const issueNum = url.split("/issues/")[1]?.split("/")[0];
		if (issueNum) {
			const resp = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/issues/${issueNum}`,
				{
					headers: {
						"Accept": "application/vnd.github.v3+json",
						"User-Agent": "pi-coding-agent",
					},
				}
			);
			if (resp.ok) {
				const data = await resp.json();
				// Format issue as markdown
				let md = `# ${data.title}\n\n`;
				md += `**#${data.number}** by ${data.user?.login || "unknown"}\n`;
				md += `Labels: ${data.labels?.map((l: any) => l.name).join(", ") || "none"}\n`;
				md += `State: ${data.state}\n\n`;
				md += `---\n\n`;
				md += data.body || "(no description)";
				return md;
			}
		}
		return null;
	}

	if (url.includes("/pull/")) {
		const prNum = url.split("/pull/")[1]?.split("/")[0];
		if (prNum) {
			const resp = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`,
				{
					headers: {
						"Accept": "application/vnd.github.v3+json",
						"User-Agent": "pi-coding-agent",
					},
				}
			);
			if (resp.ok) {
				const data = await resp.json();
				let md = `# ${data.title}\n\n`;
				md += `**PR #${data.number}** by ${data.user?.login || "unknown"}\n`;
				md += `State: ${data.state} | Draft: ${data.draft}\n`;
				md += `Base: ${data.base?.ref} ← Head: ${data.head?.ref}\n`;
				md += `Labels: ${data.labels?.map((l: any) => l.name).join(", ") || "none"}\n\n`;
				md += `---\n\n`;
				md += data.body || "(no description)";
				return md;
			}
		}
		return null;
	}

	// For raw file content
	if (parsed.isRaw || url.includes("/blob/")) {
		const filePath = url.includes("/blob/") 
			? url.split("/blob/[^/]+/")[1] 
			: path;
		if (filePath) {
			const resp = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
				{
					headers: {
						"Accept": "application/vnd.github.v3.raw+json",
						"User-Agent": "pi-coding-agent",
					},
				}
			);
			if (resp.ok) {
				const data = await resp.json();
				// Return content with file header
				return `\`\`\`${getCodeLanguage(filePath)}\n${data}\n\`\`\``;
			}
		}
	}

	return null;
}

function getCodeLanguage(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase();
	const langMap: Record<string, string> = {
		js: "javascript",
		ts: "typescript",
		jsx: "jsx",
		tsx: "tsx",
		py: "python",
		rb: "ruby",
		go: "go",
		rs: "rust",
		java: "java",
		kt: "kotlin",
		c: "c",
		cpp: "cpp",
		cs: "csharp",
		html: "html",
		css: "css",
		scss: "scss",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		md: "markdown",
		sh: "bash",
		bash: "bash",
	};
	return langMap[ext || ""] || "";
}

// ============
// HTML Utilities
// ============

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripTags(value: string): string {
	return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
	return value
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function stripInvisible(value: string): string {
	return value
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/[\u00A0]/g, " ")
		.trim();
}

function stripInvisibleUnicode(value: string): string {
	return value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function markdownToText(markdown: string): string {
	let text = markdown;
	text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
	text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
	text = text.replace(/```[\s\S]*?```/g, (block) =>
		block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
	);
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/^#{1,6}\s+/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\d+\.\s+/gm, "");
	return normalizeWhitespace(text);
}

// Simple HTML to Markdown for content rendered from readability
function htmlToMarkdown(html: string): { text: string; title?: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;

	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

	// Links
	text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
		const label = normalizeWhitespace(stripTags(body));
		if (!label) return href;
		return `[${label}](${href})`;
	});

	// Headers
	text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
		const prefix = "#".repeat(Math.max(1, Math.min(6, parseInt(level, 10))));
		const label = normalizeWhitespace(stripTags(body));
		return `\n${prefix} ${label}\n`;
	});

	// List items
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
		const label = normalizeWhitespace(stripTags(body));
		return label ? `\n- ${label}` : "";
	});

	// Breaks
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");

	// Strip remaining tags
	text = stripTags(text);
	text = normalizeWhitespace(text);

	return { text, title };
}

// ============
// Main Extension
// ============

export default function webFetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description: "Fetch content from URLs.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch content from" }),
			extractMode: Type.Optional(Type.Union([
				Type.Literal("markdown"),
				Type.Literal("text"),
			], { description: "Output format", default: "markdown" })),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (max 120)" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { url, extractMode = "markdown", timeout: timeoutParam } = params;

			// Validate URL
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			const timeout = Math.min((timeoutParam ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT);

			const headers = {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
				"Accept": "text/markdown, text/x-markdown, text/html;q=0.9, */*;q=0.1",
				"Accept-Language": "en-US,en;q=0.9",
			};

			// Fetch with timeout
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			let fetchSignal = signal;
			if (signal) {
				signal.addEventListener("abort", () => controller.abort());
			} else {
				fetchSignal = controller.signal as any;
			}

			let response: Response;
			let finalUrl = url;
			try {
				response = await fetch(url, { signal: fetchSignal, headers });
				finalUrl = response.url || url;
			} catch (err: any) {
				clearTimeout(timeoutId);
				if (err.name === "AbortError") {
					throw new Error(`Request timed out after ${timeout}ms`);
				}
				throw new Error(`Fetch failed: ${err.message}`);
			}
			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`);
			}

			const contentLength = response.headers.get("content-length");
			if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
				throw new Error(`Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_SIZE})`);
			}

			const contentType = response.headers.get("content-type") || "";
			const html = await response.text();

			let resultText: string;
			let title: string | undefined;
			let extractor = "none";

			// Try GitHub first
			if (url.includes("github.com")) {
				const githubContent = await fetchGitHubContent(url);
				if (githubContent) {
					resultText = githubContent;
					extractor = "github-api";
				} else {
					// Fall through to HTML extraction
					extractor = "none";
				}
			}

			// If not GitHub or GitHub fetch failed, try HTML extraction
			if (extractor === "none") {
				if (contentType.includes("text/html")) {
					// Try readability first
					const readable = await extractWithReadability(html, finalUrl, extractMode);
					if (readable?.text) {
						resultText = readable.text;
						title = readable.title;
						extractor = "readability";
					} else {
						// Fall back to basic extraction
						const basic = extractBasicHtml(html, extractMode);
						if (basic?.text) {
							resultText = basic.text;
							title = basic.title;
							extractor = "basic-html";
						} else {
							throw new Error("Failed to extract content from page");
						}
					}
				} else if (contentType.includes("text/markdown") || contentType.includes("text/x-markdown")) {
					// Already markdown
					resultText = html;
					extractor = "raw";
				} else if (contentType.includes("application/json")) {
					try {
						resultText = JSON.stringify(JSON.parse(html), null, 2);
						extractor = "json";
					} catch {
						resultText = html;
						extractor = "raw";
					}
				} else {
					// Plain text or unknown
					resultText = html;
					extractor = "raw";
				}
			}

			// Add title if we have one and we're in markdown mode
			if (title && extractMode === "markdown" && !resultText.startsWith("# ")) {
				resultText = `# ${title}\n\n${resultText}`;
			}

			// Apply truncation
			const truncation = truncateHead(resultText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: WebFetchDetails = {
				url,
				finalUrl,
				title,
				extractor,
				timeout,
				contentLength: resultText.length,
				contentType,
			};

			let outputText = truncation.content;
			if (truncation.truncated) {
				details.truncation = truncation;
				
				// Save full content to /tmp so LLM can continue reading from where it left off
				const slug = url.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
				const random = Math.random().toString(36).substring(2, 8);
				const tmpPath = `/tmp/webfetch_${slug}_${random}.md`;
				
				try {
					writeFileSync(tmpPath, resultText, "utf-8");
					
					// Calculate where omitted content starts (line number)
					const omittedStartLine = truncation.content.split("\n").length + 1;
					const omittedBytes = truncation.totalBytes - truncation.outputBytes;
					
					outputText += `\n\n[Full output saved to ${tmpPath}]`;
					outputText += `\n[Omitted ${formatSize(omittedBytes)} bytes, continuation starts at line ${omittedStartLine}]`;
					outputText += `\n[Use read tool with offset: ${omittedStartLine} to continue]`;
				} catch (err) {
					// Fallback: just show truncated notice
					const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
					outputText += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} (${truncatedBytes} bytes omitted)]`;
				}
			}

			// Store extractor in details for display
			details.extractor = extractor;

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},

		// Custom rendering of tool call
		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("webfetch ")) +
				theme.fg("accent", `"${args.url}"`);
			return new Text(text, 0, 0);
		},

		// Custom rendering of tool result
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as WebFetchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			if (!details) {
				return new Text(theme.fg("dim", "No content"), 0, 0);
			}

			let text = theme.fg("success", "Fetched");
			
			if (details.extractor && details.extractor !== "none" && details.extractor !== "raw") {
				text += theme.fg("dim", ` (${details.extractor})`);
			}
			
			if (details.title) {
				text += theme.fg("dim", `: ${details.title.substring(0, 40)}${details.title.length > 40 ? "..." : ""}`);
			}

			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			// In expanded view, show first few lines
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 5);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line.substring(0, 80))}`;
					}
					if (content.text.split("\n").length > 5) {
						text += `\n${theme.fg("muted", "... (truncated)")}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
