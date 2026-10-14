/**
 * Web Search Extension (Kagi)
 *
 * Adds a `web_search` tool backed by the Kagi Search API
 * (POST https://kagi.com/api/v1/search, ~$0.012 per search).
 *
 * Supports the `extract` option, which replaces the snippet of the top
 * results (max 3) with their full extracted page markdown. Extracted pages
 * are billed at the Extract API rate per page; no charge if there are no
 * results to extract.
 *
 * API key resolution:
 * 1. KAGI_API_KEY environment variable
 * 2. ~/.config/kagi/api_key file
 *
 * Placement:
 * - .pi/extensions/            (project-local, auto-discovered once project is trusted)
 * - ~/.pi/agent/extensions/    (global)
 * Quick test: pi -e .pi/extensions/web-search.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Hit {
    title: string;
    url: string;
    snippet: string;
}

const KAGI_ENDPOINT = "https://kagi.com/api/v1/search";
const KAGI_KEY_FILE = join(homedir(), ".config", "kagi", "api_key");
// Kagi allows extracting up to 10 result pages; we cap at 3 to keep output
// usable, and cap each extracted snippet so one giant page can't flood context.
const MAX_EXTRACT_COUNT = 3;
const MAX_EXTRACT_CHARS = 20_000;

function readApiKey(): string {
    const fromEnv = process.env.KAGI_API_KEY?.trim();
    if (fromEnv) return fromEnv;
    try {
        const fromFile = readFileSync(KAGI_KEY_FILE, "utf8").trim();
        if (fromFile) return fromFile;
    } catch {
        // fall through to error
    }
    throw new Error(
        `Kagi API key not found. Set KAGI_API_KEY or create ${KAGI_KEY_FILE} (generate one at kagi.com/api).`,
    );
}

/** Decode HTML entities (decode &amp; last so &amp;lt; stays literal). */
function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, "&");
}

/** Kagi snippets contain HTML like <strong>...; strip tags, decode entities, collapse to one line. */
function stripTags(s: string): string {
    return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Extracted page markdown: strip stray HTML tags and decode entities, but
 * preserve line breaks (collapsing whitespace would ruin markdown structure).
 */
function cleanMarkdown(s: string): string {
    return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/[\t \r]+\n/g, "\n").trim();
}

const webSearchTool = defineTool({
    name: "web_search",
    label: "Web Search",
    description:
        "Search the web via Kagi and return the top results with title, URL, and snippet. Optionally extract full page markdown for the top results.",
    promptSnippet: "Search the web for current information and return titles, URLs, and snippets",
    promptGuidelines: [
        "Prefer web_search to find pages when the exact URLs are unknown, e.g. for up-to-date or external information not in the local codebase.",
        "Set the extract option (extract.count at most 3) when you know ahead of time that a short summary will be insufficient and you need actual page content; the top results then come back with full page markdown in the snippet field.",
        "Prefer search with extract over web_extract when the URLs are not known yet and reading the top few results is likely enough (one call instead of two); use web_extract when you already have specific URLs or need more than 3 pages.",
        "Use both tools wisely and sparingly: search only when local information is insufficient, rely on snippets when they suffice, and remember extracted pages are billed at the Extract API rate.",
    ],
    parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        count: Type.Optional(
            Type.Number({
                minimum: 1,
                maximum: 10,
                description: "Number of results to return (default 5)",
            }),
        ),
        extract: Type.Optional(
            Type.Object({
                count: Type.Number({
                    minimum: 1,
                    maximum: MAX_EXTRACT_COUNT,
                    description:
                        `Number of top results to extract full page markdown from (max ${MAX_EXTRACT_COUNT}); the markdown replaces their snippet`,
                }),
                timeout: Type.Optional(
                    Type.Number({
                        minimum: 0.5,
                        maximum: 4,
                        description:
                            "Timeout in seconds for extraction of each page, in addition to the search timeout",
                    }),
                ),
            }),
        ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
        const count = Math.min(Math.max(Math.trunc(params.count ?? 5), 1), 10);
        const extract = params.extract
            ? {
                    count: Math.min(Math.max(Math.trunc(params.extract.count), 1), MAX_EXTRACT_COUNT),
                    ...(params.extract.timeout != null && { timeout: params.extract.timeout }),
                }
            : undefined;
        const apiKey = readApiKey();

        onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }] });

        const fetchSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000);

        let response: Response;
        try {
            response = await fetch(KAGI_ENDPOINT, {
                method: "POST",
                signal: fetchSignal,
                headers: {
                    Authorization: `Bot ${apiKey}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    query: params.query,
                    limit: count,
                    workflow: "search",
                    format: "json",
                    ...(extract && { extract }),
                }),
            });
        } catch (err) {
            if (signal?.aborted) {
                return { content: [{ type: "text", text: "Cancelled" }], details: {} };
            }
            throw new Error(`Kagi request failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            if (response.status === 401) {
                throw new Error(
                    `Kagi API key rejected (401). Check ${KAGI_KEY_FILE} or KAGI_API_KEY.`,
                );
            }
            if (response.status === 429) {
                throw new Error("Kagi API rate limited or usage limit exhausted (429).");
            }
            throw new Error(`Kagi search failed: HTTP ${response.status} ${errBody.slice(0, 200)}`);
        }

        const body = (await response.json()) as {
            data?: { search?: Array<{ title?: string; url?: string; snippet?: string }> };
        };
        const results = Array.isArray(body.data?.search) ? body.data.search : [];

        const extractedCount = extract?.count ?? 0;
        const hits: Hit[] = results
            .slice(0, count)
            .map((r, i) => {
                // Kagi replaces the snippet of the first extractedCount results with
                // full page markdown; keep its line breaks intact and cap its length.
                const isExtracted = i < extractedCount;
                const raw = isExtracted ? cleanMarkdown(r.snippet ?? "") : stripTags(r.snippet ?? "");
                const snippet =
                    isExtracted && raw.length > MAX_EXTRACT_CHARS
                        ? `${raw.slice(0, MAX_EXTRACT_CHARS)}\n\n[truncated: showing first ${MAX_EXTRACT_CHARS} of ${raw.length} chars]`
                        : raw;
                return { title: stripTags(r.title ?? ""), url: r.url ?? "", snippet };
            })
            .filter((h) => h.url && h.title);

        if (hits.length === 0) {
            return {
                content: [{ type: "text", text: `No results found for: ${params.query}` }],
                details: { query: params.query, extracted: extractedCount, results: [] },
            };
        }

        const text = hits
            .map((h, i) => {
                const head = `${i + 1}. ${h.title}\n   ${h.url}`;
                return h.snippet ? `${head}\n\n${h.snippet}` : head;
            })
            .join("\n\n---\n\n");

        return {
            content: [{ type: "text", text }],
            details: { query: params.query, extracted: extractedCount, results: hits },
        };
    },
});

export default function webSearchExtension(pi: ExtensionAPI) {
    pi.registerTool(webSearchTool);
}
