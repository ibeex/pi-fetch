import { hackerNewsCleaner } from "./hacker-news.ts";

export type ContentCleaner = {
	id: string;
	matches(url: URL): boolean;
	clean(body: string): string;
};

const CLEANERS: ContentCleaner[] = [hackerNewsCleaner];

export function cleanFetchedBody(url: string, body: string): string {
	try {
		const parsedUrl = new URL(url);
		const cleaner = CLEANERS.find((candidate) => candidate.matches(parsedUrl));
		return cleaner ? cleaner.clean(body) : body;
	} catch {
		return body;
	}
}
