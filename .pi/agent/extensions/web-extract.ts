/**
 * Web Extract Extension (Kagi)
 *
 * Adds a `web_extract` tool backed by the Kagi Extract API
 * (POST https://kagi.com/api/v1/extract, billed per extracted page,
 * see https://kagi.com/api/pricing).
 *
 * Given 1-10 HTTPS URLs, fetches each page concurrently and returns the
 * extracted markdown content, one section per URL.
 *
 * API key resolution:
 * 1. KAGI_API_KEY environment variable
 * 2. ~/.config/kagi/api_key file
 *
 * Placement:
 * - .pi/extensions/            (project-local, auto-discovered once project is trusted)
 * - ~/.pi/agent/extensions/    (global)
 * Quick test: pi -e .pi/extensions/web-extract.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KAGI_ENDPOINT = "https://kagi.com/api/v1/extract";
const KAGI_KEY_FILE = join(homedir(), ".config", "kagi", "api_key");
const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_LIMIT = 200_000;

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

/** Kagi requires valid HTTPS URLs; validate client-side to fail fast. */
function validateUrls(urls: string[]): string[] {
    const bad = urls.filter((u) => {
        try {
            const parsed = new URL(u);
            return parsed.protocol !== "https:" || parsed.hostname === "";
        } catch {
            return true;
        }
    });
    if (bad.length > 0) {
        throw new Error(
            `Invalid URL(s) - each must be a valid HTTPS URL:\n${bad.map((u) => `  - ${u}`).join("\n")}`,
        );
    }
    return urls;
}

interface PageOutput {
    url: string;
    markdown?: string | null;
    error?: string;
}

interface ErrorDetail {
    code?: string;
    message?: string;
    location?: string;
}

interface ExtractResponse {
    meta?: Record<string, unknown>;
    data?: PageOutput[];
    errors?: ErrorDetail[];
}

/** Error envelope returned for non-2xx responses; uses `error` (not `errors`). */
interface ErrorEnvelope {
    meta?: Record<string, unknown>;
    data?: unknown;
    error?: ErrorDetail[];
}

const webExtractTool = defineTool({
    name: "web_extract",
    label: "Web Extract",
    description:
        "Fetch 1-10 HTTPS URLs via Kagi and return the extracted markdown content of each page.",
    promptSnippet: "Extract markdown content from one or more web pages by URL",
    promptGuidelines: [
        "Use web_extract to get readable content from a known URL, e.g. a page found via web_search.",
        "If the exact URL is unknown, use web_search first to find it; if you only need the top few results, web_search's extract option does discovery and extraction in one call.",
        "Use sparingly: extract only the pages you actually need, and prefer search snippets when they suffice.",
    ],
    parameters: Type.Object({
        urls: Type.Array(
            Type.String({
                description: "HTTPS URL of a page to extract markdown content from",
            }),
            {
                minItems: 1,
                maxItems: 10,
                description: "1-10 HTTPS URLs to extract",
            },
        ),
        timeout: Type.Optional(
            Type.Number({
                minimum: 0.5,
                maximum: 10,
                description:
                    "Timeout in seconds for the entire bulk fetch operation (default: Kagi's own default)",
            }),
        ),
        max_chars: Type.Optional(
            Type.Number({
                minimum: 1_000,
                maximum: MAX_CHARS_LIMIT,
                description: `Truncate each page's markdown to this many characters (default ${DEFAULT_MAX_CHARS})`,
            }),
        ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
        const urls = validateUrls(params.urls);
        const maxChars = Math.min(
            Math.max(Math.trunc(params.max_chars ?? DEFAULT_MAX_CHARS), 1_000),
            MAX_CHARS_LIMIT,
        );
        const apiKey = readApiKey();

        onUpdate?.({
            content: [{ type: "text", text: `Extracting ${urls.length} page(s)...` }],
        });

        const fetchSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000);

        const body: { pages: Array<{ url: string }>; format: string; timeout?: number } = {
            pages: urls.map((url) => ({ url })),
            format: "json",
        };
        if (params.timeout != null) body.timeout = params.timeout;

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
                body: JSON.stringify(body),
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
            // ErrorEnvelope: { meta, data, error: [{ code, message, location }] }
            let detail = ` ${errBody.slice(0, 200)}`;
            try {
                const parsed = JSON.parse(errBody) as ErrorEnvelope;
                const message = parsed.error?.[0]?.message?.trim();
                if (message) detail = ` ${message}`;
            } catch {
                // keep raw body slice
            }
            throw new Error(`Kagi extract failed: HTTP ${response.status}${detail}`);
        }

        const res = (await response.json()) as ExtractResponse;
        const byUrl = new Map<string, PageOutput>();
        for (const page of Array.isArray(res.data) ? res.data : []) {
            if (page?.url) byUrl.set(page.url, page);
        }

        interface PageResult {
            url: string;
            ok: boolean;
            error?: string;
            chars?: number;
            truncated?: boolean;
        }

        const results: PageResult[] = [];
        const sections: string[] = [];
        let succeeded = 0;

        for (const url of urls) {
            const page = byUrl.get(url);
            if (!page) {
                results.push({ url, ok: false, error: "no response from Kagi" });
                sections.push(`### ${url}\n\n**Extraction failed:** no response from Kagi`);
                continue;
            }
            if (page.error) {
                results.push({ url, ok: false, error: page.error });
                sections.push(`### ${url}\n\n**Extraction failed:** ${page.error}`);
                continue;
            }
            const markdown = (page.markdown ?? "").trim();
            if (!markdown) {
                results.push({ url, ok: false, error: "extraction returned no content" });
                sections.push(`### ${url}\n\n**Extraction failed:** extraction returned no content`);
                continue;
            }
            const truncated = markdown.length > maxChars;
            const text = truncated
                ? `${markdown.slice(0, maxChars)}\n\n[truncated: showing first ${maxChars} of ${markdown.length} chars]`
                : markdown;
            results.push({ url, ok: true, chars: markdown.length, truncated });
            sections.push(`### ${url}\n\n${text}`);
            succeeded += 1;
        }

        const apiErrors = res.errors?.map((e) => e.message ?? e.code ?? "unknown error") ?? [];
        if (apiErrors.length > 0) {
            sections.push(`### API errors\n\n${apiErrors.map((e) => `- ${e}`).join("\n")}`);
        }

        const header = `Extracted ${succeeded}/${urls.length} page(s)`;
        const text = `${header}\n\n${sections.join("\n\n---\n\n")}`;

        return {
            content: [{ type: "text", text }],
            details: { urls, pages: results, apiErrors },
        };
    },
});

export default function webExtractExtension(pi: ExtensionAPI) {
    pi.registerTool(webExtractTool);
}
