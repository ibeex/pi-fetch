import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanFetchedBody } from "./cleaners/index.ts";

const execFileAsync = promisify(execFile);

const JINA_READER_URL = "https://r.jina.ai/";
const DEFAULT_USER_AGENT = "pi-fetch/0.1";
const DEFAULT_TIMEOUT_MS = parsePositiveInt(process.env.PI_FETCH_TIMEOUT_MS, 30_000);
const DEFAULT_MAX_CONTEXT_CHARS = parsePositiveInt(process.env.PI_FETCH_MAX_CONTEXT_CHARS, 28_000);
const DEFAULT_PASS_PATH = process.env.PI_FETCH_JINA_PASS_PATH?.trim() || "api/jina";
const CONTENT_TRUNCATED_MARKER = "[Content truncated for context]";
const FETCH_CONTEXT_CUSTOM_TYPE = "pi-fetch-context";
const FETCH_RESULT_CUSTOM_TYPE = "pi-fetch-result";
const FETCH_STATUS_KEY = "pi-fetch";
const FETCH_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FETCH_STATUS_TICK_MS = 80;
type FetchMode = "auto" | "raw" | "jina";
type FetchDelivery = "nextPrompt" | "afterCurrentRun";

type FetchResult = {
	url: string;
	mode: Exclude<FetchMode, "auto">;
	status: number;
	contentType: string;
	content: string;
	truncated: boolean;
	rawLength: number;
	contextLength: number;
	omittedLength: number;
	fullOutputPath?: string;
};

type FetchDisplayDetails =
	| {
			ok: true;
			delivery: FetchDelivery;
			url: string;
			mode: Exclude<FetchMode, "auto">;
			status: number;
			contentType: string;
			truncated: boolean;
			rawLength: number;
			contextLength: number;
			omittedLength: number;
			contextContent: string;
			fullOutputPath?: string;
	  }
	| {
			ok: false;
			error: string;
			url?: string;
			mode?: Exclude<FetchMode, "auto">;
	  };

class HttpStatusError extends Error {
	status: number;
	detail: string;

	constructor(status: number, statusText: string, detail: string) {
		super(detail ? `HTTP ${status} ${statusText}: ${detail}` : `HTTP ${status} ${statusText}`);
		this.name = "HttpStatusError";
		this.status = status;
		this.detail = detail;
	}
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const value = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function shortenUrl(value: string, maxLength = 96): string {
	if (value.length <= maxLength) {
		return value;
	}
	const separator = "...";
	const available = maxLength - separator.length;
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return `${value.slice(0, head)}${separator}${value.slice(-tail)}`;
}

function truncateForContext(
	text: string,
	limit: number,
): { content: string; truncated: boolean; contextLength: number; omittedLength: number } {
	const normalized = text.trim() || "(empty response body)";
	if (normalized.length <= limit) {
		return { content: normalized, truncated: false, contextLength: normalized.length, omittedLength: 0 };
	}
	const content = normalized.slice(0, limit).trimEnd();
	return {
		content: `${content}\n${CONTENT_TRUNCATED_MARKER}`,
		truncated: true,
		contextLength: content.length,
		omittedLength: normalized.length - content.length,
	};
}

function preprocessFetchedBody(url: string, body: string): string {
	return cleanFetchedBody(url, body);
}

function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1).trim();
		}
	}
	return trimmed;
}

function validateUrl(value: string): string {
	const candidate = stripWrappingQuotes(value);
	if (!candidate) {
		throw new Error("URL must not be empty.");
	}
	const parsed = new URL(candidate);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("URL must start with http:// or https://.");
	}
	if (!parsed.hostname) {
		throw new Error("URL must include a hostname.");
	}
	return parsed.toString();
}

function normalizeHostname(hostname: string): string {
	const trimmed = hostname.trim().toLowerCase();
	const withoutBrackets =
		trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return withoutBrackets.endsWith(".") ? withoutBrackets.slice(0, -1) : withoutBrackets;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return false;
	}

	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

function isPrivateIpv6(hostname: string): boolean {
	return (
		hostname === "::" ||
		hostname === "::1" ||
		hostname.startsWith("fc") ||
		hostname.startsWith("fd") ||
		hostname.startsWith("fe80:")
	);
}

function isLikelyPrivateHostname(hostname: string): boolean {
	if (!hostname) {
		return false;
	}

	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		return true;
	}

	const ipVersion = isIP(hostname);
	if (ipVersion === 4) {
		return isPrivateIpv4(hostname);
	}
	if (ipVersion === 6) {
		return isPrivateIpv6(hostname);
	}

	return !hostname.includes(".");
}

function isLocalUrl(value: string): boolean {
	const hostname = normalizeHostname(new URL(value).hostname);
	return isLikelyPrivateHostname(hostname);
}

function resolveMode(url: string, mode: FetchMode): Exclude<FetchMode, "auto"> {
	if (mode === "raw" || mode === "jina") {
		return mode;
	}
	return isLocalUrl(url) ? "raw" : "jina";
}

function shouldRetryWithJinaApiKey(status: number, detail: string): boolean {
	const normalized = detail.toLowerCase();
	return (
		status === 401 ||
		status === 403 ||
		status === 429 ||
		normalized.includes("rate limit") ||
		normalized.includes("too many requests") ||
		normalized.includes("authentication is required") ||
		normalized.includes("authenticationrequirederror") ||
		normalized.includes("provide a valid api key") ||
		normalized.includes("authorization header")
	);
}

function describeDelivery(delivery: FetchDelivery): string {
	return delivery === "nextPrompt"
		? "Available to the model in your next prompt."
		: "Will be added after the current run finishes.";
}

function formatAddedNotice(result: FetchResult): string {
	if (!result.truncated) {
		return `Fetched ${result.url} via ${result.mode} and added ${formatCount(result.contextLength)} chars to context.`;
	}
	return `Fetched ${result.url} via ${result.mode}. Retrieved ${formatCount(result.rawLength)} chars; kept ${formatCount(result.contextLength)} chars in context and omitted ${formatCount(result.omittedLength)}.`;
}

function parseCommandArgs(args: string): string {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new Error("Usage: /fetch <url>");
	}
	return validateUrl(trimmed);
}

function buildContextMessage(result: FetchResult): string {
	const lines = [
		"Fetched web content explicitly requested by the user:",
		`URL: ${result.url}`,
		`Mode: ${result.mode}`,
		`Status: ${result.status}`,
		`Content-Type: ${result.contentType}`,
		`Raw-Length: ${result.rawLength}`,
		`Context-Length: ${result.contextLength}`,
		`Omitted-Length: ${result.omittedLength}`,
	];
	if (result.fullOutputPath) {
		lines.push(`Full-Response-Path: ${result.fullOutputPath}`);
	}
	lines.push("", result.content);
	return lines.join("\n");
}

function queueFetchedContext(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: FetchResult,
): FetchDelivery {
	const delivery: FetchDelivery = ctx.isIdle() ? "nextPrompt" : "afterCurrentRun";
	const message = {
		customType: FETCH_CONTEXT_CUSTOM_TYPE,
		content: buildContextMessage(result),
		display: false,
		details: {
			url: result.url,
			mode: result.mode,
			status: result.status,
			contentType: result.contentType,
			truncated: result.truncated,
			rawLength: result.rawLength,
			contextLength: result.contextLength,
			omittedLength: result.omittedLength,
			fullOutputPath: result.fullOutputPath,
		},
	};

	if (ctx.isIdle()) {
		pi.sendMessage(message);
		return delivery;
	}

	pi.sendMessage(message, { deliverAs: "followUp" });
	return delivery;
}

function sendFetchResultMessage(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: FetchResult,
	delivery: FetchDelivery,
): void {
	const details: FetchDisplayDetails = {
		ok: true,
		delivery,
		url: result.url,
		mode: result.mode,
		status: result.status,
		contentType: result.contentType,
		truncated: result.truncated,
		rawLength: result.rawLength,
		contextLength: result.contextLength,
		omittedLength: result.omittedLength,
		contextContent: result.content,
		fullOutputPath: result.fullOutputPath,
	};
	const message = {
		customType: FETCH_RESULT_CUSTOM_TYPE,
		content: formatAddedNotice(result),
		display: true,
		details,
	};

	if (ctx.isIdle()) {
		pi.sendMessage(message);
		return;
	}

	pi.sendMessage(message, { deliverAs: "steer" });
}

function sendFetchFailureMessage(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	error: string,
	url?: string,
	mode?: Exclude<FetchMode, "auto">,
): void {
	const prefix = url ? `Fetch failed for ${url}` : "Fetch failed";
	const details: FetchDisplayDetails = {
		ok: false,
		error,
		url,
		mode,
	};
	const message = {
		customType: FETCH_RESULT_CUSTOM_TYPE,
		content: `${prefix}: ${error}`,
		display: true,
		details,
	};

	if (ctx.isIdle()) {
		pi.sendMessage(message);
		return;
	}

	pi.sendMessage(message, { deliverAs: "steer" });
}

function startFetchStatus(
	ctx: ExtensionCommandContext,
	url: string,
	mode: Exclude<FetchMode, "auto">,
): () => void {
	if (!ctx.hasUI) {
		return () => {};
	}

	let frame = 0;
	const render = () => {
		const spinner = ctx.ui.theme.fg("accent", FETCH_STATUS_FRAMES[frame % FETCH_STATUS_FRAMES.length]!);
		const label = ctx.ui.theme.fg("dim", ` Fetching ${shortenUrl(url, 72)} via ${mode}...`);
		ctx.ui.setStatus(FETCH_STATUS_KEY, spinner + label);
		frame++;
	};

	render();
	const timer = setInterval(render, FETCH_STATUS_TICK_MS);

	return () => {
		clearInterval(timer);
		ctx.ui.setStatus(FETCH_STATUS_KEY, undefined);
	};
}

function buildPreview(content: string, maxLines = 3, maxCharsPerLine = 100): { text: string; clipped: boolean } {
	const normalized = content.replace(`\n${CONTENT_TRUNCATED_MARKER}`, "").trim();
	if (!normalized) {
		return { text: "(empty response body)", clipped: false };
	}

	const sourceLines = normalized
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const previewLines = sourceLines.slice(0, maxLines).map((line) => {
		if (line.length <= maxCharsPerLine) {
			return line;
		}
		return `${line.slice(0, maxCharsPerLine).trimEnd()}…`;
	});
	const clipped =
		sourceLines.length > previewLines.length || previewLines.some((line, index) => line !== sourceLines[index]);
	return { text: previewLines.join("\n"), clipped };
}

function renderFetchResult(message: { content: string; details?: unknown }, expanded: boolean, theme: any): Text {
	const details = message.details as FetchDisplayDetails | undefined;
	if (!details) {
		return new Text(message.content, 0, 0);
	}

	if (!details.ok) {
		let text = theme.fg("error", "✗ fetch failed");
		if (details.url) {
			text += "\n" + theme.fg("muted", shortenUrl(details.url));
		}
		if (details.mode) {
			text += "\n" + theme.fg("dim", `Mode: ${details.mode}`);
		}
		text += "\n" + theme.fg("error", details.error);
		return new Text(text, 0, 0);
	}

	let text = theme.fg("success", "✓ ") + theme.fg("accent", "fetch ") + theme.fg("muted", shortenUrl(details.url));
	text += "\n" + theme.fg("dim", `via ${details.mode} • HTTP ${details.status} • ${details.contentType}`);

	if (details.truncated) {
		text +=
			"\n" +
			theme.fg(
				"warning",
				`${formatCount(details.contextLength)} of ${formatCount(details.rawLength)} chars were added to context (${formatCount(details.omittedLength)} omitted)`,
			);
	} else {
		text += "\n" + theme.fg("success", `${formatCount(details.contextLength)} chars added to context`);
	}

	text += "\n" + theme.fg("muted", describeDelivery(details.delivery));

	if (!expanded) {
		const preview = buildPreview(details.contextContent);
		text += "\n\n" + theme.fg("dim", preview.text);
		if (preview.clipped || details.truncated) {
			text += "\n" + theme.fg("dim", "…");
		}
		text += "\n" + theme.fg("muted", `(${keyHint("app.tools.expand", "to inspect captured content")})`);
		return new Text(text, 0, 0);
	}

	if (details.truncated) {
		text +=
			"\n\n" +
			theme.fg(
				"warning",
				`Only the first ${formatCount(details.contextLength)} chars below were injected into model context.`,
			);
	}

	if (details.fullOutputPath) {
		text += "\n" + theme.fg("muted", `Full response saved to: ${details.fullOutputPath}`);
	}

	text += "\n\n" + theme.fg("accent", theme.bold("Captured context content"));
	text += `\n${details.contextContent}`;
	return new Text(text, 0, 0);
}

async function getJinaApiKey(): Promise<string> {
	const envKey = process.env.JINA_API_KEY?.trim() || process.env.JINA_API_TOKEN?.trim();
	if (envKey) {
		return envKey;
	}

	try {
		const result = await execFileAsync("pass", [DEFAULT_PASS_PATH]);
		const lines = result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length === 0) {
			throw new Error(`pass ${DEFAULT_PASS_PATH} returned no secret.`);
		}
		return lines[0];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Jina API key not available. Set JINA_API_KEY or store it in pass at ${DEFAULT_PASS_PATH}. (${message})`,
		);
	}
}

async function persistFullOutput(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-fetch-"));
	const filePath = join(directory, "response.txt");
	await writeFile(filePath, text, "utf8");
	return filePath;
}

async function fetchText(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; body: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			...init,
			signal: controller.signal,
		});
		const body = (await response.text()).trim() || "(empty response body)";
		return { response, body };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request timed out after ${timeoutMs}ms.`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function runRawRequest(url: string, timeoutMs: number, maxContextChars: number): Promise<FetchResult> {
	const { response, body } = await fetchText(
		url,
		{
			headers: {
				"user-agent": DEFAULT_USER_AGENT,
				accept: "text/plain,text/html,application/json,application/xml;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
			},
		},
		timeoutMs,
	);
	if (!response.ok) {
		throw new HttpStatusError(response.status, response.statusText, body);
	}
	const processedBody = preprocessFetchedBody(url, body);
	const truncated = truncateForContext(processedBody, maxContextChars);
	const fullOutputPath = truncated.truncated ? await persistFullOutput(processedBody) : undefined;
	return {
		url,
		mode: "raw",
		status: response.status,
		contentType: response.headers.get("content-type") || "unknown",
		content: truncated.content,
		truncated: truncated.truncated,
		rawLength: processedBody.length,
		contextLength: truncated.contextLength,
		omittedLength: truncated.omittedLength,
		fullOutputPath,
	};
}

async function runJinaRequest(
	url: string,
	timeoutMs: number,
	maxContextChars: number,
	apiKey?: string,
): Promise<FetchResult> {
	const headers: Record<string, string> = {
		"user-agent": DEFAULT_USER_AGENT,
		accept: "text/plain",
		"accept-language": "en-US,en;q=0.9",
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const { response, body } = await fetchText(`${JINA_READER_URL}${url}`, { headers }, timeoutMs);
	if (!response.ok) {
		throw new HttpStatusError(response.status, response.statusText, body);
	}

	const processedBody = preprocessFetchedBody(url, body);
	const truncated = truncateForContext(processedBody, maxContextChars);
	const fullOutputPath = truncated.truncated ? await persistFullOutput(processedBody) : undefined;
	return {
		url,
		mode: "jina",
		status: response.status,
		contentType: response.headers.get("content-type") || "text/plain",
		content: truncated.content,
		truncated: truncated.truncated,
		rawLength: processedBody.length,
		contextLength: truncated.contextLength,
		omittedLength: truncated.omittedLength,
		fullOutputPath,
	};
}

async function fetchUrl(
	url: string,
	mode: FetchMode,
	timeoutMs: number,
	maxContextChars: number,
): Promise<FetchResult> {
	const resolvedMode = resolveMode(url, mode);
	if (resolvedMode === "raw") {
		return runRawRequest(url, timeoutMs, maxContextChars);
	}

	try {
		return await runJinaRequest(url, timeoutMs, maxContextChars);
	} catch (error) {
		if (!(error instanceof HttpStatusError) || !shouldRetryWithJinaApiKey(error.status, error.detail)) {
			throw error;
		}
		const apiKey = await getJinaApiKey();
		return runJinaRequest(url, timeoutMs, maxContextChars, apiKey);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter(
				(message) => (message as { customType?: string }).customType !== FETCH_RESULT_CUSTOM_TYPE,
			),
		};
	});

	pi.registerMessageRenderer(FETCH_RESULT_CUSTOM_TYPE, (message, options, theme) => {
		return renderFetchResult(message as { content: string; details?: unknown }, options.expanded, theme);
	});

	pi.registerCommand("fetch", {
		description: "Fetch a URL and add the content to session context for the next prompt",
		handler: async (args, ctx) => {
			let url: string | undefined;
			let mode: Exclude<FetchMode, "auto"> | undefined;
			let stopStatus = () => {};

			try {
				url = parseCommandArgs(args);
				mode = resolveMode(url, "auto");
				stopStatus = startFetchStatus(ctx, url, mode);

				const result = await fetchUrl(url, "auto", DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONTEXT_CHARS);
				const delivery = queueFetchedContext(pi, ctx, result);
				sendFetchResultMessage(pi, ctx, result, delivery);

				if (ctx.hasUI && delivery === "afterCurrentRun") {
					ctx.ui.notify(`${formatAddedNotice(result)} It will be appended after the current run finishes.`, "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendFetchFailureMessage(pi, ctx, message, url, mode);
				if (ctx.hasUI && !ctx.isIdle()) {
					ctx.ui.notify(`Fetch failed: ${message}`, "warning");
				}
			} finally {
				stopStatus();
			}
		},
	});
}
