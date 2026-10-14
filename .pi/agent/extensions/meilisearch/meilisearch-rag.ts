/**
 * Meilisearch RAG Extension (context injection + search tool)
 *
 * A hands-off RAG system for pi with three integration points:
 *
 * - `session_start`      — indexes the project in the background: walks the
 *                           working directory, skips binaries and ignored
 *                           dirs, splits text into overlapping line-aligned
 *                           chunks, and upserts them into a Meilisearch
 *                           index (idempotent: a file's chunks are replaced
 *                           on re-index).
 * - `before_agent_start` — searches the project's index with queries built
 *                           from the user's prompt and, on the first prompt
 *                           that yields results, injects the top chunks as
 *                           an invisible message — extra context the prompt
 *                           itself won't include.
 * - `project_search` tool — on-demand semantic search over the same index.
 *                           The agent calls it for follow-up lookups
 *                           (definitions, call sites, "how does X work")
 *                           with an identifier or a natural-language query;
 *                           its notes recommend it over rg/grep for finding
 *                           code, with rg/grep kept for exact patterns, match
 *                           counts, and files created after session start.
 *
 * Projects are isolated: each project directory gets its own index named
 * after the basename of its directory (mirroring how pi scopes sessions by
 * `basename $PWD`), so chunks from one project can never be injected into
 * another project's session.
 *
 * The search waits for the session's indexing to finish, so a fresh session
 * that types a prompt immediately still gets the full corpus. If
 * Meilisearch is unreachable, pi simply runs without RAG (a warning is
 * shown in the TUI). Projects without active trust are left untouched.
 *
 * Configuration (environment variables):
 * - MEILISEARCH_URL        default http://127.0.0.1:7700
 *                          (the clink `pi` container sets http://meilisearch:7700)
 * - MEILISEARCH_API_KEY    master/search key, if the server requires one
 * - MEILISEARCH_INDEX      fixed index UID override (default: a per-project
 *                          index named after the basename of the project
 *                          directory)
 * - MEILISEARCH_MAX_FILE_KB max file size to index, in KB (default 1024)
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, relative } from "node:path";
import {
    Meilisearch,
    MeilisearchApiError,
    MeilisearchRequestTimeOutError,
    MeilisearchTaskTimeOutError,
    type EnqueuedTask,
    type SearchResponse,
    type Task,
} from "meilisearch";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CFG = {
    url: (process.env.MEILISEARCH_URL ?? "http://127.0.0.1:7700").trim().replace(/\/+$/, ""),
    apiKey: process.env.MEILISEARCH_API_KEY?.trim() || undefined,
    indexOverride: process.env.MEILISEARCH_INDEX?.trim() || undefined,
    maxFileBytes: (Number(process.env.MEILISEARCH_MAX_FILE_KB) || 1024) * 1024,
};

// Tuning constants
const CHUNK_TARGET_CHARS = 800; // ~200 tokens (dense, symbol-sized for code)
const CHUNK_OVERLAP_CHARS = 200; // lines carried into the next chunk
const ADD_BATCH_SIZE = 1_000; // Meilisearch max docs per add request
const DELETE_BATCH_SIZE = 50; // paths per filter-delete request
const CONTEXT_LIMIT = 5; // chunks injected per session
const SEARCH_CANDIDATE_LIMIT = 20; // hits fetched per attempt (before capping)
const MAX_HITS_PER_PATH = 3; // max chunks per file in the injected context
const MAX_TOOL_LIMIT = 10; // max chunks the project_search tool may return
const MIN_ANCHOR_CHARS = 4; // anchors shorter than this (src, rs, ...) are skipped
const MAX_ANCHORS = 5; // candidate queries tried per prompt (run concurrently)
const MAX_QUERY_WORDS = 10; // = the server's words-criterion window (first 10 tokens)
const MIN_RELEVANCE_SCORE = 0.12; // below this the best hit is noise: skip injection
const MAX_CHUNK_CONTEXT_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 12_000; // cap on the injected message
const TASK_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000; // per-request client timeout (search, uploads, tasks)

// Meilisearch ships with no default stop words, which makes token matching
// fail on natural-language prompts ("and", "the", ...). A conservative
// English function-word list; technical terms are left alone.
const DEFAULT_STOP_WORDS = [
    "a", "an", "the", "and", "or", "but", "if", "while", "because", "until",
    "of", "to", "in", "on", "for", "with", "at", "by", "from", "into", "about",
    "against", "between", "through", "during", "before", "after", "above",
    "below", "up", "down", "out", "off", "over", "under", "again", "further",
    "then", "once", "here", "there", "when", "where", "why", "how",
    "all", "any", "both", "each", "few", "more", "most", "other", "some",
    "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
    "very", "can", "will", "just", "should", "now", "is", "are", "was",
    "were", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "would", "could", "might", "must", "shall", "may", "as", "it",
    "its", "this", "that", "these", "those", "i", "you", "he", "she", "we",
    "they", "what", "which", "who", "whom", "s", "t", "don", "d", "ll",
    "re", "ve", "am",
];

// Query-side-only noise words: common dev-English that carries no search
// signal. Deliberately NOT added to DEFAULT_STOP_WORDS (which also configures
// the index): a corpus may legitimately contain identifiers named "state",
// "view", "user", ... — dropping them at index time would make them
// unsearchable. They only keep queries short and the ranking undiluted.
const QUERY_NOISE_WORDS = [
    "added", "adding", "new", "create", "created", "creating", "change",
    "changed", "changes", "update", "updated", "updating", "modify",
    "modified", "modifying", "implement", "implemented", "implementing",
    "implementation", "make", "made", "making", "fix", "fixed", "fixing",
    "support", "supported", "using", "use", "used", "return", "returns",
    "call", "called", "calls", "handle", "handled", "handles", "show",
    "shown", "display", "displayed", "get", "gets", "set", "sets", "run",
    "runs", "write", "wrote", "written", "need", "needs", "needed", "want",
    "wants", "wanted", "method", "function", "placeholder", "code", "file",
    "files", "like", "based", "currently", "active", "available", "actually",
    "really", "please", "kindly", "correctly", "properly", "proper",
    "instead", "within", "without", "across", "extend", "extends",
    "ok", "okay", "first", "second", "third", "also",
    "bug", "bugs", "issue", "issues", "commit", "commits", "git",
];

/** Directory and file names never worth indexing (keeps the corpus clean + fast). */
const IGNORED_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "target",
    "out",
    "bin",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".idea",
    ".vscode",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "coverage",
    "vendor",
    ".pi",
]);
const NOISE_FILE_NAMES = new Set([
    ".gitignore",
    ".dockerignore",
    ".containerignore",
    ".npmignore",
    ".ignore",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lockb",
    "go.sum",
]);

/** True for files excluded from the index by name (see NOISE_FILE_NAMES). */
function isNoiseFile(name: string): boolean {
    return (
        NOISE_FILE_NAMES.has(name) ||
        name.endsWith(".lock") ||
        name.endsWith(".min.js") ||
        name.endsWith(".min.css")
    );
}

class MeiliError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "MeiliError";
        this.status = status;
    }
}

let clientInstance: Meilisearch | undefined;

/** Lazily construct the client (first use happens after the server is up). */
function client(): Meilisearch {
    if (!clientInstance) {
        clientInstance = new Meilisearch({
            host: CFG.url,
            apiKey: CFG.apiKey,
            timeout: REQUEST_TIMEOUT_MS,
        });
    }
    return clientInstance;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Map client errors to friendly messages: API errors (4xx/5xx) keep their
 * HTTP status so callers can special-case 404; timeout/network failures get
 * actionable hints.
 */
function mapError(err: unknown): Error {
    if (err instanceof MeilisearchApiError) {
        return new MeiliError(err.response.status, err.cause?.message ?? err.message);
    }
    if (err instanceof MeilisearchRequestTimeOutError) {
        return new Error(
            `Request to Meilisearch at ${CFG.url} timed out after ${err.cause.timeout}ms. ` +
                `Is the server under load?`,
        );
    }
    if (err instanceof MeilisearchTaskTimeOutError) {
        return new Error(
            `Timed out after ${Math.round(err.cause.timeout / 1000)}s waiting for Meilisearch task(s)`,
        );
    }
    // For request errors (MeilisearchRequestError & friends), the original
    // failure (e.g. "fetch failed") is the more useful half of the message.
    const detail = err instanceof Error && err.cause ? errMsg(err.cause) : errMsg(err);
    return new Error(
        `Cannot reach Meilisearch at ${CFG.url} (${detail}). ` +
            `Is the server running? Configure it with MEILISEARCH_URL.`,
    );
}

/** Run a client call, mapping any thrown error to a friendly message. */
async function call<T>(op: () => Promise<T>): Promise<T> {
    try {
        return await op();
    } catch (err) {
        if (err instanceof MeiliError) throw err;
        throw mapError(err);
    }
}

/**
 * Wait for enqueued tasks to finish. The client's waitForTasks resolves
 * even for failed tasks, so statuses are checked here.
 */
async function waitTasks(taskUids: Array<number | EnqueuedTask>): Promise<void> {
    const tasks: Task[] = await call(() =>
        client().tasks.waitForTasks(taskUids, { timeout: TASK_TIMEOUT_MS, interval: 500 }),
    );
    const failures = tasks.filter((t) => t.status === "failed" || t.status === "canceled");
    if (failures.length > 0) {
        throw new Error(
            `Meilisearch task(s) failed:\n${failures
                .map((t) => `  - task ${t.uid} (${t.type}): ${t.error?.message ?? t.status}`)
                .join("\n")}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Per-project index UID: the basename of the project directory, sanitized
 * to Meilisearch's valid UID charset [a-zA-Z0-9_-] (max 128 bytes).
 */
function indexFor(cwd: string): string {
    if (CFG.indexOverride) return CFG.indexOverride;
    const base = basename(cwd) || "root";
    let clean = base.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (clean.length > 128) {
        const h = createHash("sha256").update(base).digest("hex").slice(0, 31);
        clean = `${clean.slice(0, 96)}_${h}`;
    }
    return clean || "root";
}

/** Create the index if missing and (re)apply RAG-oriented settings. */
async function ensureIndex(index: string): Promise<void> {
    try {
        await call(() => client().getIndex(index));
    } catch (err) {
        if (err instanceof MeiliError && err.status === 404) {
            await call(() => client().createIndex(index, { primaryKey: "id" }));
        } else {
            throw err;
        }
    }
    const task = await call(() =>
        client().index(index).updateSettings({
            displayedAttributes: ["path", "file_name", "ext", "abs_path", "start_line", "end_line", "chunk"],
            searchableAttributes: ["chunk", "path"],
            filterableAttributes: ["path", "file_name", "ext", "abs_path"],
            stopWords: DEFAULT_STOP_WORDS,
        }),
    );
    await waitTasks([task]);
}

/** Escape a string literal for Meilisearch filter expressions. */
function meiliString(s: string): string {
    return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Delete previously indexed chunks for the given absolute file paths.
 * Enqueued before the add tasks; tasks for the same index apply in order,
 * so deletes land before the new documents.
 */
async function deleteDocsForPaths(index: string, absPaths: string[]): Promise<number[]> {
    const tasks: number[] = [];
    for (let i = 0; i < absPaths.length; i += DELETE_BATCH_SIZE) {
        const batch = absPaths.slice(i, i + DELETE_BATCH_SIZE);
        const values = batch.map((p) => meiliString(p));
        const filter =
            batch.length === 1
                ? `abs_path = ${values[0]}`
                : `abs_path IN [${values.join(", ")}]`;
        const task = await call(() => client().index(index).deleteDocuments({ filter }));
        tasks.push(task.taskUid);
    }
    return tasks;
}

interface Doc {
    id: string;
    path: string;
    abs_path: string;
    file_name: string;
    ext: string;
    start_line: number;
    end_line: number;
    hash: string;
    chunk: string;
}

/** List the abs_path of every document currently in the index. */
async function existingAbsPaths(index: string): Promise<string[]> {
    const paths = new Set<string>();
    for (let from = 0; from < 20_000; from += ADD_BATCH_SIZE) {
        const { hits } = await call(
            () => client().index(index).search("", { offset: from, limit: ADD_BATCH_SIZE }),
        );
        for (const h of hits) {
            if (typeof h.abs_path === "string") paths.add(h.abs_path);
        }
        if (hits.length < ADD_BATCH_SIZE) break;
    }
    return [...paths];
}

/** Read + chunk one file into index documents. Returns null for binaries. */
async function fileToDocs(abs: string, relPath: string): Promise<Doc[] | null> {
    let raw: Buffer;
    try {
        raw = await readFile(abs);
    } catch {
        return null;
    }
    if (raw.subarray(0, 8_192).includes(0)) return null; // binary
    let text = raw.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM

    const chunks = chunkText(text);
    if (chunks.length === 0) return null;
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
    const ext = extname(abs).replace(/^\./, "").toLowerCase();
    // Meilisearch >= 1.53 rejects doc ids outside [a-zA-Z0-9_-] (max 511
    // bytes), so ids are the sha256 of the stable (relPath, chunk) pair.
    // Stale chunks are still handled: re-indexing deletes by abs_path first.
    return chunks.map((c, i) => ({
        id: createHash("sha256").update(`${relPath}#${i}`).digest("hex"),
        path: relPath,
        abs_path: abs,
        file_name: basename(abs),
        ext,
        start_line: c.startLine,
        end_line: c.endLine,
        hash,
        chunk: c.text,
    }));
}

interface TextChunk {
    text: string;
    startLine: number; // 1-based, inclusive
    endLine: number; // 1-based, inclusive
}

/**
 * Split text into overlapping, line-aligned chunks.
 *
 * Accumulates lines until `targetChars` would be exceeded, emits the chunk,
 * then carries the tail lines (≤ `overlapChars`) into the next one so context
 * straddling a boundary is not lost. Lines longer than `targetChars`
 * (minified files, etc.) are hard-split by character count.
 */
function chunkText(content: string): TextChunk[] {
    const targetChars = CHUNK_TARGET_CHARS;
    const overlapChars = CHUNK_OVERLAP_CHARS;
    let lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline

    const chunks: TextChunk[] = [];
    let buf: string[] = [];
    let bufStart = 1; // 1-based line number of buf[0]
    let bufLen = 0;

    const emit = (endLine: number): void => {
        if (buf.length === 0) return;
        chunks.push({ text: buf.join("\n"), startLine: bufStart, endLine });
    };

    const keepOverlap = (): void => {
        const tail: string[] = [];
        let len = 0;
        let start = bufStart;
        for (let i = buf.length - 1; i >= 0; i--) {
            const add = buf[i].length + (tail.length > 0 ? 1 : 0);
            if (len + add > overlapChars && tail.length > 0) break;
            tail.unshift(buf[i]);
            len += add;
            start = bufStart + i;
        }
        buf = tail;
        bufStart = start;
        bufLen = len;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.length > targetChars) {
            emit(i); // flush what we have (covers lines 1..i)
            for (let p = 0; p < line.length; p += targetChars) {
                chunks.push({ text: line.slice(p, p + targetChars), startLine: i + 1, endLine: i + 1 });
            }
            buf = [];
            bufStart = i + 2;
            bufLen = 0;
            continue;
        }

        const add = line.length + (buf.length > 0 ? 1 : 0);
        if (buf.length > 0 && bufLen + add > targetChars) {
            emit(i); // buf covers up to (and including) 1-based line i
            keepOverlap();
        }
        if (buf.length === 0) bufStart = i + 1;
        buf.push(line);
        bufLen += add;
    }
    emit(lines.length);

    return chunks;
}

/** Recursively list regular files under `root`, skipping ignored directories. */
async function walkFiles(root: string): Promise<string[]> {
    const files: string[] = [];

    const walk = async (dir: string): Promise<void> => {
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable directory — skip
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) {
                if (IGNORED_DIRS.has(e.name)) continue;
                await walk(full);
            } else if (e.isFile() && !isNoiseFile(e.name)) {
                const st = await stat(full).catch(() => null);
                if (st && st.size <= CFG.maxFileBytes) files.push(full);
            }
            // symlinks & special files: skipped
        }
    };

    await walk(root);
    return files;
}

/**
 * Walk `cwd`, chunk the files, and upsert them into the index.
 * Idempotent per file: existing chunks for each file are deleted first.
 */
async function indexProject(cwd: string, index: string): Promise<void> {
    const files = await walkFiles(cwd);
    if (files.length === 0) throw new Error(`Nothing to index under ${cwd}`);

    const allDocs: Doc[] = [];
    const indexedFiles: string[] = [];
    for (const abs of files) {
        const docs = await fileToDocs(abs, relative(cwd, abs).split("\\").join("/"));
        if (docs === null) continue; // binary or empty
        allDocs.push(...docs);
        indexedFiles.push(abs);
    }
    if (allDocs.length === 0) {
        throw new Error(`Nothing to index under ${cwd} (all files binary or empty?)`);
    }

    await ensureIndex(index);
    // Delete stale docs: every file we are about to re-add, plus any docs
    // whose file no longer exists on disk (or became noise after a filter
    // change), so nothing outlives the re-index.
    const existing = await existingAbsPaths(index);
    const deleteTasks = await deleteDocsForPaths(index, [...new Set([...existing, ...indexedFiles])]);
    // addDocumentsInBatches enqueues one task per ≤1000-document batch
    const addTasks: EnqueuedTask[] = [];
    for (const p of client().index(index).addDocumentsInBatches(allDocs, ADD_BATCH_SIZE)) {
        addTasks.push(await call(() => p));
    }
    await waitTasks([...deleteTasks, ...addTasks]);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Server behavior verified empirically against the v1.53.1 this project
// runs (search API only, no server source):
//
// - Underscores ARE token separators, on both index and query sides: the
//   query "show_all_messages" is the words [show, all, messages] with
//   "all" removed as a stop word; `git_blame` in a document is [git, blame].
// - matchingStrategy "last" makes the FIRST word of the query the hard
//   filter (exact match — no prefix, no typo tolerance). Single-word
//   queries keep prefix and typo tolerance. ("all" requires every word to
//   be present.)
// - The `words` ranking criterion counts the LONGEST PREFIX of the query
//   present in the document: counting stops at the first query word that
//   is not in the chunk. Only the FIRST 10 query tokens are considered
//   (maxMatchingWords caps at 10; stop words occupy window slots but are
//   not counted). So a document containing words 1, 3 and 4 of a 6-word
//   query scores 1/6 — word ORDER is part of the query, and words 11+
//   can never score at all.
//
// Three consequences shape buildQueries():
//
// 1. A code identifier in the prompt is the strongest signal, but it
//    arrives as plain words once the server splits the underscore, so in
//    a bag-of-words query it drowns: the 18 generic words of "currently
//    added new placeholder method ... implement make changes git state"
//    all count against the 2 real words of `show_all_messages`, and chunks
//    that happen to contain six of the generic words outrank the chunk that
//    contains the identifier. Identifier queries are therefore their own
//    attempts: the identifier's parts and nothing else, strategy "all" —
//    precise by construction, since the defining file's chunks contain
//    every part (in order, which the prefix rule rewards).
// 2. The natural-language attempts are anchor-first ("last" strategy,
//    first word = hard filter). Anchors are the FIRST content words of the
//    prompt in order of appearance: the user's opening sentence usually
//    names the target ("The chat bubble layout ..."), so the earliest words
//    are the best filters — longest-first picking "adjustments"/"estimating"
//    instead of "bubble"/"layout" was exactly the v1 failure mode.
// 3. Ranker order matters because of the prefix rule: words that are
//    likely to be in the target chunk go first (identifier parts, then the
//    remaining content words in prompt order, mirroring the phrasing the
//    user borrowed the target words from), and the query fills the full
//    10-token window so no slot is wasted. QUERY_NOISE_WORDS keeps the
//    common dev-English words out of the query entirely — under the prefix
//    rule a single unmatchable word in position 2 zeroes out everything
//    after it, so dead words are not just dilution, they are sabotage.
//
// Queries are built from lowercased, stop-word-free tokens, which also
// sidesteps two v1.53 server quirks (case-sensitive stop-word removal on
// queries; a leading capital defeating the removal).

interface BuiltQuery {
    anchor: string; // label for the debug header (identifier or anchor word)
    query: string;
    strategy: "all" | "last";
}

/** True for tokens that look like code identifiers (original casing). */
function isCodeToken(raw: string): boolean {
    return raw.includes("_") || /\d/.test(raw) || /[a-z][A-Z]/.test(raw);
}

/**
 * Candidate queries for a prompt.
 *
 * 1. Identifier attempts (strategy "all"): one per code identifier —
 *    backticked spans first (an explicit code reference), then any
 *    code-shaped bare token (underscore, digit, or camelCase). The query
 *    is the identifier's underscore parts and nothing else.
 * 2. Natural-language attempts (strategy "last"): one per remaining
 *    content word, in order of first appearance (the prompt's opening
 *    words name the target; see the section comment on the server's
 *    prefix-counting `words` criterion). Each query is anchor +
 *    rankers in likelihood order (identifier parts first, then prompt
 *    order), filling the 10-token window.
 */
function buildQueries(prompt: string): BuiltQuery[] {
    const isStop = (w: string): boolean => DEFAULT_STOP_WORDS.includes(w);
    const isNoise = (w: string): boolean => isStop(w) || QUERY_NOISE_WORDS.includes(w);

    // Split on anything that is not a word character (backticks, periods,
    // commas, ...). Underscores are kept; the server splits them later.
    const rawTokens = prompt.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    const lower = rawTokens.map((t) => t.toLowerCase());

    // Identifier candidates: backticked spans first (a span like
    // `src/boxcutter_tests.rs` yields src, boxcutter_tests, rs), then any
    // code-shaped bare token in the prompt.
    const candidateRaw: string[] = [];
    const seen = new Set<string>();
    const consider = (raw: string): void => {
        const key = raw.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            candidateRaw.push(raw);
        }
    };
    for (const m of prompt.matchAll(/`([^`]+)`/g)) {
        for (const t of m[1].split(/[^A-Za-z0-9_]+/).filter(Boolean)) consider(t);
    }
    for (const raw of rawTokens) {
        if (isCodeToken(raw)) consider(raw);
    }

    const queries: BuiltQuery[] = [];
    const idParts: string[] = [];
    for (const raw of candidateRaw) {
        // Parts keep only the default stop-word filter: "show" in
        // `show_all_messages` is a query-side noise word, but it is the
        // actual name here and must stay.
        const parts = raw
            .toLowerCase()
            .split("_")
            .filter((p) => p.length > 0 && !isStop(p));
        if (parts.length === 0) continue;
        if (parts.length === 1 && parts[0].length < MIN_ANCHOR_CHARS) continue;
        if (queries.length >= MAX_ANCHORS) break;
        queries.push({ anchor: raw.toLowerCase(), query: parts.join(" "), strategy: "all" });
        for (const p of parts) if (!idParts.includes(p)) idParts.push(p);
    }

    // Natural-language attempts over the remaining content words, in
    // order of first appearance in the prompt. Words that are identifier
    // candidates (e.g. the snake_case token itself) are skipped: the
    // identifier attempts already cover them.
    const distinct: string[] = [];
    for (const w of lower) {
        if (isNoise(w) || seen.has(w)) continue;
        if (!distinct.includes(w)) distinct.push(w);
    }
    // Parts of an identifier are covered by the identifier attempts; keep
    // the NL anchors diverse.
    const anchors = distinct.filter((w) => !idParts.includes(w));

    for (const anchor of anchors) {
        if (queries.length >= MAX_ANCHORS) break;
        // Ranker order matters: the server's `words` criterion counts the
        // longest query PREFIX present in a document, so the most likely
        // target-chunk words go right after the anchor (identifier parts,
        // then prompt order) and the query fills the 10-token window.
        const rankPool = [...idParts, ...distinct]
            .filter((w, i, arr) => arr.indexOf(w) === i)
            .filter((w) => w !== anchor);
        queries.push({
            anchor,
            query: [anchor, ...rankPool.slice(0, MAX_QUERY_WORDS - 1)].join(" "),
            strategy: "last",
        });
    }
    return queries;
}

interface SearchAttempt {
    anchor: string;
    query: string;
    scoreSum: number; // sum of the top CONTEXT_LIMIT _rankingScore values
    attemptNo: number; // 1-based position among the candidate queries
    attemptTotal: number;
    hits: SearchResponse["hits"];
}

interface SearchResult {
    query: string; // the winning attempt's query (recorded for debugging)
    anchor: string;
    scoreSum: number; // the winning attempt's combined score
    attemptNo: number;
    attemptTotal: number;
    mergedFrom: number; // attempts that contributed at least one hit
    topScore: number; // best _rankingScore in the merged pool (pre-cap)
    hits: SearchResponse["hits"]; // final selection (capped)
}

/**
 * Run every candidate query concurrently and merge the results.
 *
 * Attempts are independent read-only searches, so they run concurrently:
 * total latency is one round-trip, not the sum. Each attempt fetches
 * SEARCH_CANDIDATE_LIMIT hits; the hits are pooled (deduplicated by doc id,
 * best score kept), ranked, and the final `limit` are picked with a
 * MAX_HITS_PER_PATH cap, so a single file that matches many query words
 * (the `words` ranking rule) cannot monopolize the context.
 *
 * Attempt quality is the combined score: the sum of the top CONTEXT_LIMIT
 * _rankingScore values. A single top score is too noisy to compare across
 * queries; the combined score favors the anchor that retrieves a coherent
 * cluster of relevant chunks.
 *
 * A single failed attempt is tolerated (the other anchors may still hit);
 * only when every attempt fails is the first error rethrown.
 */
async function searchMerged(index: string, prompt: string, limit: number): Promise<SearchResult | null> {
    const queries = buildQueries(prompt);
    if (queries.length === 0) return null;

    const settled = await Promise.allSettled(
        queries.map(async ({ anchor, query, strategy }, i): Promise<SearchAttempt> => {
            const { hits } = await doSearch(index, query, strategy);
            const scoreSum = hits
                .slice(0, CONTEXT_LIMIT)
                .reduce((s, h) => s + (typeof h._rankingScore === "number" ? h._rankingScore : 0), 0);
            return { anchor, query, scoreSum, attemptNo: i + 1, attemptTotal: queries.length, hits };
        }),
    );

    const attempts: SearchAttempt[] = [];
    let failures = 0;
    let firstError: unknown = null;
    for (const r of settled) {
        if (r.status === "rejected") {
            failures++;
            firstError ??= r.reason;
            continue;
        }
        if (r.value.hits.length > 0) attempts.push(r.value);
    }
    if (failures === queries.length) {
        throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    if (attempts.length === 0) return null;

    attempts.sort((a, b) => b.scoreSum - a.scoreSum);

    // Pool the hits: one entry per doc, best score across attempts.
    // Search responses carry no _id (only displayedAttributes), so docs are
    // keyed by (path, start_line) — unique per chunk.
    const pool = new Map<string, any>();
    for (const attempt of attempts) {
        for (const hit of attempt.hits) {
            const score = typeof hit._rankingScore === "number" ? hit._rankingScore : 0;
            const key = `${hit.path ?? "?"}#${hit.start_line ?? "?"}`;
            const prev = pool.get(key);
            const prevScore = prev && typeof prev._rankingScore === "number" ? prev._rankingScore : 0;
            if (!prev || score > prevScore) pool.set(key, hit);
        }
    }
    const ranked = [...pool.values()].sort(
        (a, b) =>
            (typeof b._rankingScore === "number" ? b._rankingScore : 0) -
            (typeof a._rankingScore === "number" ? a._rankingScore : 0),
    );

    const topScore =
        ranked[0] && typeof ranked[0]._rankingScore === "number" ? ranked[0]._rankingScore : 0;

    const hits: SearchResponse["hits"] = [];
    const perPath = new Map<string, number>();
    for (const hit of ranked) {
        const path = String(hit.path ?? "?");
        const n = perPath.get(path) ?? 0;
        if (n >= MAX_HITS_PER_PATH) continue;
        perPath.set(path, n + 1);
        hits.push(hit);
        if (hits.length >= limit) break;
    }

    const best = attempts[0];
    return {
        query: best.query,
        anchor: best.anchor,
        scoreSum: best.scoreSum,
        attemptNo: best.attemptNo,
        attemptTotal: queries.length,
        mergedFrom: attempts.length,
        topScore,
        hits,
    };
}

/**
 * Passive-injection search: the merged search with a noise floor.
 * _rankingScore is query-relative, but observed useful hits in this project
 * sit at ≥ 0.18 while irrelevant matches cluster at ≤ 0.12. Below the
 * floor, silence beats guessing (and the next prompt gets another chance —
 * contextInjected stays unset). The project_search tool skips this floor:
 * an explicit query deserves an honest (if weak) answer.
 */
async function searchContext(index: string, prompt: string): Promise<SearchResult | null> {
    const result = await searchMerged(index, prompt, CONTEXT_LIMIT);
    if (!result || result.topScore < MIN_RELEVANCE_SCORE) return null;
    return result;
}

/** Best-effort chunk count of an index, for friendly no-hit messages. */
async function docCount(index: string): Promise<number | undefined> {
    try {
        const stats = await call(() => client().index(index).getStats());
        return typeof stats.numberOfDocuments === "number" ? stats.numberOfDocuments : undefined;
    } catch {
        return undefined; // index missing / server unreachable
    }
}

/** One search round-trip against the given index with the RAG-tuned parameters. */
async function doSearch(index: string, q: string, strategy: "all" | "last"): Promise<SearchResponse> {
    return call(() =>
        client().index(index).search(q, {
            // More than CONTEXT_LIMIT: searchContext caps per path, so a
            // single dominant file cannot block out the rest.
            limit: SEARCH_CANDIDATE_LIMIT,
            showRankingScore: true,
            attributesToHighlight: [],
            attributesToCrop: [],
            // "last": the first token is the hard filter (exact match); the
            // rest only influence ranking. "all": every word must be present
            // — used for short identifier queries where the defining chunks
            // contain all the parts (see section comment).
            matchingStrategy: strategy,
        }),
    );
}

/**
 * Format the winning attempt as numbered chunks for injection into the
 * agent context, with the issued query recorded for debugging.
 */
function formatHits(result: SearchResult, index: string, forTool = false): string {
    const parts = result.hits.map((h, i) => {
        const loc =
            h.start_line != null && h.end_line != null
                ? h.start_line === h.end_line
                    ? `${h.path}:${h.start_line}`
                    : `${h.path}:${h.start_line}-${h.end_line}`
                : String(h.path ?? "?");
        const score =
            typeof h._rankingScore === "number" ? ` (score ${h._rankingScore.toFixed(3)})` : "";
        let text = String(h.chunk ?? "");
        if (text.length > MAX_CHUNK_CONTEXT_CHARS) {
            text = `${text.slice(0, MAX_CHUNK_CONTEXT_CHARS)}\n... [chunk truncated]`;
        }
        return `[${i + 1}] ${loc}${score}\n${text}`;
    });
    const header =
        (forTool
            ? `Results for project_search (index: ${index}).\n`
            : `Relevant chunks from the project index (background context, not part of the user's request).\n`) +
        `RAG query: "${result.query}" (anchor: ${result.anchor}, ` +
        `attempt ${result.attemptNo}/${result.attemptTotal}, combined score: ${result.scoreSum.toFixed(3)}, ` +
        `${result.mergedFrom} attempt(s) merged, max ${MAX_HITS_PER_PATH} per path)`;
    let out = `${header}\n\n${parts.join("\n\n")}`;
    if (out.length > MAX_CONTEXT_CHARS) {
        out = `${out.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated]`;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function meilisearchRagExtension(pi: ExtensionAPI): void {
    // Per-session state: pi reloads extensions between sessions, so this
    // resets for each new/resumed session.
    let indexPromise: Promise<void> | undefined;
    let indexError: string | undefined;
    let contextInjected = false;

    const projectSearchTool = defineTool({
        name: "project_search",
        label: "Project Search",
        description:
            "Semantic search over this project's codebase. Searches the project's Meilisearch" +
            "index (built from all project files at session start) and returns the most relevant" +
            "chunks: file path, line range, relevance score, and full chunk text. Accepts a code " +
            "identifier (e.g. show_all_messages) or a natural-language question (e.g. how are " +
            "chat bubbles laid out).",
        promptSnippet:
            "Search this project's codebase semantically; returns ranked chunks with path, line " +
            "range, and score",
        promptGuidelines: [
            "Prefer project_search over rg/grep to find code or information in this project: " +
            "it ranks semantically, accepts identifiers and natural language, and returns full " +
            "context chunks with file:line locations.",
            "Use rg/grep only for exact pattern matches, match counts, or when project_search " +
            "finds nothing relevant.",
            "project_search returns chunks, not whole files: use read on the returned path:line " +
            "when you need full context.",
        ],
        parameters: Type.Object({
            query: Type.String({
                description:
                    "Code identifier (e.g. show_all_messages) or natural-language question about the project",
            }),
            limit: Type.Optional(
                Type.Number({
                    minimum: 1,
                    maximum: MAX_TOOL_LIMIT,
                    description: `Number of chunks to return (default ${CONTEXT_LIMIT}, max ${MAX_TOOL_LIMIT})`,
                }),
            ),
        }),
        constrainedSampling: { type: "json_schema", strict: "prefer" },
        annotations: { readOnlyHint: true, idempotentHint: true },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (signal?.aborted) {
                return { content: [{ type: "text", text: "Cancelled" }], details: undefined };
            }
            const index = indexFor(ctx.cwd);
            if (!ctx.isProjectTrusted()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Project is not trusted, so it was not indexed. Ask the user to " +
                                "trust the project, or use rg/grep.",
                        },
                    ],
                    details: { error: "project not trusted" },
                };
            }
            if (!indexPromise) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No index for ${index} is available yet (the session has not ` +
                                "indexed the project). Use rg/grep for this query.",
                        },
                    ],
                    details: { error: "no index yet" },
                };
            }
            // Resolves even on failure; the failure is captured in indexError.
            await indexPromise;
            if (indexError) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `The project index failed to build (${indexError}). Use rg/grep for this session.`,
                        },
                    ],
                    details: { error: indexError },
                };
            }
            let result: SearchResult | null;
            try {
                const limit = Math.min(Math.max(Math.trunc(params.limit ?? CONTEXT_LIMIT), 1), MAX_TOOL_LIMIT);
                result = await searchMerged(index, params.query, limit);
            } catch (err) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `project_search failed: ${errMsg(err)}. Use rg/grep instead.`,
                        },
                    ],
                    details: { error: errMsg(err) },
                };
            }
            if (!result) {
                const docs = await docCount(index);
                return {
                    content: [
                        {
                            type: "text",
                            text: `No chunks matched "${params.query}" in index ${index}` +
                                `${docs != null ? ` (${docs} chunks indexed)` : ""}. ` +
                                "Try different words, a code identifier, or rg/grep.",
                        },
                    ],
                    details: { matched: 0 },
                };
            }
            return {
                content: [{ type: "text", text: formatHits(result, index, true) }],
                details: { query: result.query, anchor: result.anchor, matches: result.hits.length },
            };
        },
    });

    pi.registerTool(projectSearchTool);

    pi.on("session_start", (_event, ctx) => {
        if (!ctx.isProjectTrusted()) return;
        const index = indexFor(ctx.cwd);
        // Fire and forget: don't block startup. before_agent_start awaits
        // this promise before the first search; project_search does too.
        indexError = undefined;
        indexPromise = indexProject(ctx.cwd, index).catch((err) => {
            indexError = errMsg(err);
            ctx.ui.notify(`RAG: indexing ${index} failed: ${indexError}`, "warning");
        });
    });

    pi.on("before_agent_start", async (event, ctx) => {
        if (contextInjected || !ctx.isProjectTrusted()) return;
        const prompt = event.prompt.trim();
        if (prompt.length === 0) return;
        const index = indexFor(ctx.cwd);
        try {
            await indexPromise; // may be undefined; resolves even on failure
            const result = await searchContext(index, prompt);
            if (!result) return; // no hits yet: try again on the next prompt
            contextInjected = true;
            return {
                message: { customType: "meilisearch-rag", content: formatHits(result, index), display: false },
            };
        } catch (err) {
            ctx.ui.notify(`RAG: search failed: ${errMsg(err)}`, "warning");
        }
    });
}
