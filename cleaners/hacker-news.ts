import type { ContentCleaner } from "./index.ts";

const HN_URL_PATTERN = String.raw`https?:\/\/news\.ycombinator\.com`;
const HN_VOTE_LINK_RE = new RegExp(String.raw`${HN_URL_PATTERN}\/vote\?id=`);
const HN_ITEM_LINK_RE = new RegExp(String.raw`\[(?<count>\d+\s+comments?)\]\(${HN_URL_PATTERN}\/item\?id=\d+[^)]*\)`);
const HN_COMMENT_HEADER_RE = new RegExp(
	String.raw`^\[(?<user>[^\]]+)\]\(${HN_URL_PATTERN}\/user\?id=[^)]+\)\[(?<age>[^\]]+)\]\(${HN_URL_PATTERN}\/item\?id=\d+[^)]*\)(?<tail>[\s\S]*)$`,
);
const HN_SEGMENT_SPLIT_RE = new RegExp(
	String.raw`(?:!?\[Image \d+\]\(${HN_URL_PATTERN}\/s\.gif\))?\[\]\(${HN_URL_PATTERN}\/vote\?id=`,
);
const HN_PLAIN_STATS_RE =
	/^(?<points>\d+\s+points?)\s+by\s+(?<submitter>\S+)\s+(?<age>.+?)\s+\|\s+.*?(?<comments>\d+\s+comments?)\s*$/;
const HN_PLAIN_COMMENT_HEADER_RE = /^(?<user>\S+)\s+(?<age>.+?\bago)\s+\|\s+.+\[[^\]]+\]$/;

function simplifyMarkdownText(value: string): string {
	let cleaned = value;
	cleaned = cleaned.replace(/!?\[Image \d+\]\([^)]*\)/g, "");
	cleaned = cleaned.replace(/\[\[[^\]]*\]\]\(javascript:void\(0\)\)/g, "");
	cleaned = cleaned.replace(/\[\]\([^)]*\)/g, "");

	for (const label of ["reply", "parent", "next", "prev", "root", "hide", "favorite", "past", "help", "login"]) {
		cleaned = cleaned.replace(new RegExp(`\\[${label}\\]\\([^)]+\\)`, "gi"), "");
	}

	cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string) => {
		const text = label.trim();
		if (!text) {
			return "";
		}
		if (/^https?:\/\//i.test(text)) {
			return text;
		}
		return text;
	});

	cleaned = cleaned.replace(/\s+\|\s+/g, " • ");
	cleaned = cleaned.replace(/(?:\s*•\s*){2,}/g, " • ");
	cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
	return cleaned.trim();
}

function formatStoryHeader(segment: string): string[] {
	let rest = segment;
	const lines = ["Hacker News discussion"];

	const titleMatch = rest.match(/^\[(?<title>[^\]]+)\]\((?<link>[^)]+)\)(?<tail>[\s\S]*)$/);
	if (titleMatch?.groups) {
		lines.push("", `Title: ${titleMatch.groups.title}`, `Article: ${titleMatch.groups.link}`);
		rest = titleMatch.groups.tail;
	}

	const siteMatch = rest.match(/^\s*\(\[(?<site>[^\]]+)\]\([^)]+\)\)(?<tail>[\s\S]*)$/);
	if (siteMatch?.groups) {
		lines.push(`Site: ${siteMatch.groups.site}`);
		rest = siteMatch.groups.tail;
	}

	const statsMatch = rest.match(
		/(?<points>\d+\s+points?)\s+by\s+\[(?<submitter>[^\]]+)\]\([^)]+\)\[(?<age>[^\]]+)\]\([^)]+\)/,
	);
	if (statsMatch?.groups) {
		lines.push(`Points: ${statsMatch.groups.points}`);
		lines.push(`Submitter: ${statsMatch.groups.submitter}`);
		lines.push(`Posted: ${statsMatch.groups.age}`);
	}

	const commentsMatch = rest.match(HN_ITEM_LINK_RE);
	if (commentsMatch?.groups) {
		lines.push(`Comments: ${commentsMatch.groups.count}`);
	}

	let extraLinks = simplifyMarkdownText(rest);
	extraLinks = extraLinks.replace(/^.*?\d+\s+points?\s+by\s+.+?comments/i, "").trim();
	extraLinks = extraLinks.replace(/^•\s*/, "").trim();
	if (extraLinks) {
		lines.push("", `Links: ${extraLinks}`);
	}

	return lines;
}

function extractPageTitle(lines: string[]): string | undefined {
	const titleLine = lines.find((line) => line.startsWith("Title: "));
	if (!titleLine) {
		return undefined;
	}
	const title = titleLine.slice("Title: ".length).replace(/\s+\|\s+Hacker News$/i, "").trim();
	return title || undefined;
}

function looksLikeStoryHeader(segment: string): boolean {
	return /^\[[^\]]+\]\([^)]+\)/.test(segment) || /\d+\s+points?\s+by\s+\[/.test(segment) || HN_ITEM_LINK_RE.test(segment);
}

function formatComment(segment: string, index: number): string | undefined {
	const commentMatch = segment.match(HN_COMMENT_HEADER_RE);
	if (!commentMatch?.groups) {
		const fallback = simplifyMarkdownText(segment);
		return fallback ? `${index}. ${fallback}` : undefined;
	}

	let body = commentMatch.groups.tail;
	body = body.replace(/^(?:\s*\|\s*\[(?:parent|next|prev|root)\]\([^)]+\))+/gi, "");
	body = body.replace(/^\s*\[\[[^\]]*\]\]\(javascript:void\(0\)\)\s*/i, "");
	body = simplifyMarkdownText(body).replace(/^•\s*/, "").trim();
	if (!body) {
		return undefined;
	}

	return `${index}. ${commentMatch.groups.user} — ${commentMatch.groups.age}\n${body}`;
}

function normalizePlainLine(line: string): string {
	return line.replace(/\u00a0/g, " ").trim();
}

function collapsePlainTextParagraphs(lines: string[]): string {
	const paragraphs: string[] = [];
	let current: string[] = [];

	for (const rawLine of lines) {
		const line = normalizePlainLine(rawLine);
		if (!line) {
			if (current.length > 0) {
				paragraphs.push(current.join(" "));
				current = [];
			}
			continue;
		}
		current.push(line);
	}

	if (current.length > 0) {
		paragraphs.push(current.join(" "));
	}

	return paragraphs.join("\n\n").trim();
}

function cleanPlainTextHackerNewsItemContent(lines: string[]): string | undefined {
	const normalizedLines = lines.map(normalizePlainLine);
	const statsIndex = normalizedLines.findIndex((line) => HN_PLAIN_STATS_RE.test(line));
	if (statsIndex < 0) {
		return undefined;
	}

	const statsMatch = normalizedLines[statsIndex].match(HN_PLAIN_STATS_RE);
	if (!statsMatch?.groups) {
		return undefined;
	}

	let titleLine = "";
	for (let index = statsIndex - 1; index >= 0; index -= 1) {
		const candidate = normalizedLines[index];
		if (!candidate || /^#/.test(candidate) || /^Hacker News/i.test(candidate) || candidate === "help") {
			continue;
		}
		titleLine = candidate;
		break;
	}

	const output = ["Hacker News discussion"];
	if (titleLine) {
		const titleMatch = titleLine.match(/^(?<title>.+?)\s+\((?<site>[^()]+\.[^()]+)\)$/);
		if (titleMatch?.groups) {
			output.push("", `Title: ${titleMatch.groups.title}`, `Site: ${titleMatch.groups.site}`);
		} else {
			output.push("", `Title: ${titleLine}`);
		}
	}

	output.push(`Points: ${statsMatch.groups.points}`);
	output.push(`Submitter: ${statsMatch.groups.submitter}`);
	output.push(`Posted: ${statsMatch.groups.age}`);
	output.push(`Comments: ${statsMatch.groups.comments}`);

	const comments: string[] = [];
	for (let index = statsIndex + 1; index < normalizedLines.length; index += 1) {
		const line = normalizedLines[index];
		const commentMatch = line.match(HN_PLAIN_COMMENT_HEADER_RE);
		if (!commentMatch?.groups) {
			continue;
		}

		const bodyLines: string[] = [];
		for (index += 1; index < normalizedLines.length; index += 1) {
			const currentLine = normalizedLines[index];
			if (!currentLine) {
				bodyLines.push("");
				continue;
			}
			if (currentLine === "reply") {
				break;
			}
			if (/^Guidelines\b/i.test(currentLine)) {
				index = normalizedLines.length;
				break;
			}
			if (HN_PLAIN_COMMENT_HEADER_RE.test(currentLine)) {
				index -= 1;
				break;
			}
			bodyLines.push(currentLine);
		}

		const body = collapsePlainTextParagraphs(bodyLines);
		if (!body) {
			continue;
		}

		comments.push(`${comments.length + 1}. ${commentMatch.groups.user} — ${commentMatch.groups.age}\n${body}`);
	}

	if (comments.length > 0) {
		output.push("", "Comments:", "", comments.join("\n\n"));
	}

	return output.join("\n").trim() || undefined;
}

function cleanHackerNewsItemContent(body: string): string {
	const lines = body.split(/\r?\n/).map((line) => line.trimEnd());
	const pageTitle = extractPageTitle(lines);
	const markdownIndex = lines.findIndex((line) => line.trim() === "Markdown Content:");
	const markdownLines = markdownIndex >= 0 ? lines.slice(markdownIndex + 1) : lines;
	const discussionLine = markdownLines.find((line) => HN_VOTE_LINK_RE.test(line));
	if (discussionLine) {
		const segments = discussionLine
			.split(HN_SEGMENT_SPLIT_RE)
			.map((segment) => segment.replace(/^\d+&how=up&goto=[^)]*\)/, "").trim())
			.filter(Boolean);
		if (segments.length > 0) {
			const hasStoryHeader = looksLikeStoryHeader(segments[0]);
			const output = hasStoryHeader ? formatStoryHeader(segments[0]) : ["Hacker News discussion"];
			if (!hasStoryHeader && pageTitle) {
				output.push("", `Title: ${pageTitle}`);
			}
			const commentSegments = hasStoryHeader ? segments.slice(1) : segments;
			const comments = commentSegments
				.map((segment, index) => formatComment(segment, index + 1))
				.filter((comment): comment is string => Boolean(comment));

			if (comments.length > 0) {
				output.push("", "Comments:", "", comments.join("\n\n"));
			}

			return output.join("\n").trim() || body;
		}
	}

	return cleanPlainTextHackerNewsItemContent(markdownLines) || body;
}

export const hackerNewsCleaner: ContentCleaner = {
	id: "hacker-news-item",
	matches(url) {
		return url.hostname === "news.ycombinator.com" && url.pathname === "/item";
	},
	clean(body) {
		return cleanHackerNewsItemContent(body);
	},
};
