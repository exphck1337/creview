import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext as PiContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext as OmpContext } from "@oh-my-pi/pi-coding-agent";

// One file for both hosts: omp and pi load it through their own manifest key. It imports nothing from either host at
// runtime (pi can't resolve @oh-my-pi/*, and omp serves @oh-my-pi/* only to static imports), so the type imports
// above are the only host imports and what differs per host is the `Host` object chosen at load time.

// creview.json is the source of truth: each reviewer's model and each preset's members. In omp,
// agents/reviewer-<name>.md is generated from templates/reviewer.md (not an agent) for every reviewer; in pi the
// template is the reviewers' prompt. All of it lives in this package: the parent of extensions/ (fileURLToPath drops
// omp's ?mtime query; pi's loader has no import.meta.dir).
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = path.join(ROOT, "agents");
const DATA_FILE = path.join(ROOT, "creview.json");
const TEMPLATE_FILE = path.join(ROOT, "templates", "reviewer.md");
const agentFile = (name: string) => path.join(AGENTS_DIR, `reviewer-${name}.md`);

type Presets = Record<string, string[]>;
type Data = { reviewers: Record<string, string>; presets: { omp: Presets; pi: Presets } };
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Only a missing file means "no presets"; a file that can't be read, parsed, or has the wrong shape throws (naming the
// file) before anything is synced or written.
const readData = (): Data => {
	if (!fs.existsSync(DATA_FILE)) return { reviewers: {}, presets: { omp: {}, pi: {} } };
	let data: unknown;
	try {
		data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
	} catch (err) {
		throw new Error(`creview.json: ${errorText(err)}`);
	}
	if (!isObject(data)) throw new Error('creview.json: must be an object with "reviewers" and "presets"');
	const { reviewers = {}, presets = {} } = data;
	if (!isObject(reviewers) || !Object.values(reviewers).every(m => typeof m === "string"))
		throw new Error('creview.json: "reviewers" must be an object of model strings');
	const isPresets = (v: unknown): v is Presets =>
		isObject(v) && Object.values(v).every(m => Array.isArray(m) && m.every(n => typeof n === "string"));
	// A flat map, including presets named "omp" or "pi", belongs entirely to omp.
	if (isPresets(presets)) return { reviewers: reviewers as Data["reviewers"], presets: { omp: presets, pi: {} } };
	if (!isObject(presets) || Object.keys(presets).some(k => k !== "omp" && k !== "pi") ||
		!isPresets(presets.omp ?? {}) || !isPresets(presets.pi ?? {}) || presets.omp === null || presets.pi === null)
		throw new Error('creview.json: "presets" must contain omp and pi objects of name lists');
	return { reviewers: reviewers as Data["reviewers"], presets: { omp: (presets.omp ?? {}) as Presets, pi: (presets.pi ?? {}) as Presets } };
};
const writeData = ({ reviewers, presets }: Data) => {
	const sorted = Object.fromEntries(Object.keys(reviewers).sort().map(n => [n, reviewers[n]]));
	fs.writeFileSync(DATA_FILE, `${JSON.stringify({ reviewers: sorted, presets }, null, 2)}\n`);
};

const NAME = /^[a-z0-9-]+$/;
const MODEL = /^[^/\s:"]+\/[^\s"]+$/; // provider/id[:level]
const MODEL_BLOCK = /^model:\n(?:  - .*\n)+/m;

function checkReviewer(name: string, model: unknown): void {
	if (!NAME.test(name) || typeof model !== "string" || !MODEL.test(model))
		throw new Error(`creview.json: invalid reviewer "${name}": ${JSON.stringify(model)}`);
}

// The template with LF line ends (a CRLF checkout would not match MODEL_BLOCK); throws when it is missing.
function readTemplate(): string {
	if (!fs.existsSync(TEMPLATE_FILE)) throw new Error("templates/reviewer.md is missing");
	return fs.readFileSync(TEMPLATE_FILE, "utf8").replace(/\r\n/g, "\n");
}

// Every reviewer's agent file, by path. Throws (nothing written yet) on a missing or malformed template or entry.
// Agent files are written with LF.
function renderAgents(reviewers: Data["reviewers"]): Map<string, string> {
	const template = readTemplate();
	if (!/^name: .*$/m.test(template) || !MODEL_BLOCK.test(template)) throw new Error("templates/reviewer.md lacks a name: line or model: list");
	return new Map(
		Object.entries(reviewers).map(([name, model]) => {
			checkReviewer(name, model);
			const text = template
				.replace(/^name: .*$/m, () => `name: reviewer-${name}`)
				.replace(MODEL_BLOCK, () => `model:\n  - "${model}"\n`);
			return [agentFile(name), text] as const;
		}),
	);
}

// Writes only the files whose content differs (no mtime churn) and deletes reviewer-*.md files of unknown reviewers.
function syncAgents(files: Map<string, string>): void {
	fs.mkdirSync(AGENTS_DIR, { recursive: true });
	for (const [file, text] of files) if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
	for (const f of fs.readdirSync(AGENTS_DIR)) {
		const file = path.join(AGENTS_DIR, f);
		if (/^reviewer-.+\.md$/.test(f) && !files.has(file)) fs.rmSync(file);
	}
}

const NO_PRESETS = 'No review presets yet. Run /creview-config and choose "Create a preset".';

// Under each preset its reviewers and models, and why the host can't run a reviewer's model (`unusable`).
function listText(host: Host, ctx: Ctx): string {
	const { reviewers, presets } = readData();
	const current = presets[host.id];
	const names = Object.keys(current);
	if (!names.length) return NO_PRESETS;
	const line = (n: string) => {
		const model = reviewers[n];
		const why = model === undefined ? undefined : host.unusable(ctx, model);
		return `  reviewer-${n}  ${model ?? "(unknown reviewer)"}${why ? `  (${why})` : ""}`;
	};
	return names.map(p => `${p}:\n${current[p].map(line).join("\n")}`).join("\n");
}

const REVIEW_USAGE = "Usage: /creview <preset> [scope and instructions]. /creview-config lists the presets.";
const CANCELLED = "Cancelled; nothing changed.";
const NOTHING = "Nothing selected; nothing changed.";
const ADD_MODEL = "Add model";
const NO_LEVEL = "(none)";

// Reviewer name for a model: its id without provider and :level, lowercased, other characters as hyphens
// (opencode-go/glm-5.3:high -> glm-5-3).
const deriveName = (modelId: string) => modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function membersOf(presets: Presets, preset: string): string[] {
	if (!presets[preset]) throw new Error(`Unknown preset "${preset}". Available: ${Object.keys(presets).join(", ") || "none"}`);
	return presets[preset];
}

// A new preset needs a valid, unused name; any other must exist.
function checkPreset(presets: Presets, preset: string, isNew: boolean): void {
	if (!isNew) return void membersOf(presets, preset);
	if (!NAME.test(preset)) throw new Error(`Invalid preset name "${preset}" (use [a-z0-9-]+)`);
	if (presets[preset]) throw new Error(`Preset "${preset}" already exists`);
}

type Entry = { name: string; model?: string };

// Adds reviewers to an existing preset, or creates the preset with them (`isNew`). An entry with a model must use a
// new name or one that already has exactly that model (it then just joins); without one, the reviewer must exist.
// Everything is validated (in omp the template too) before the one write of creview.json and, in omp, agents/.
function add(host: Host, ctx: Ctx, preset: string, entries: Entry[], isNew: boolean): string {
	const data = readData();
	const presets = data.presets[host.id];
	checkPreset(presets, preset, isNew);
	if (!entries.length) throw new Error("A preset needs at least one reviewer");
	const wrote: string[] = [];
	for (const { name, model } of entries) {
		if (!NAME.test(name)) throw new Error(`Invalid reviewer name "${name}" (use [a-z0-9-]+)`);
		const current = data.reviewers[name];
		if (!model && current === undefined) throw new Error(`Unknown reviewer "${name}"`);
		if (model && current !== undefined && current !== model)
			// The picker hides reviewers this host can't run, so say what holds the name.
			throw new Error(
				host.unusable(ctx, current)
					? `"${name}" is taken by a reviewer this host can't run (${current}); pick another name`
					: `"${name}" is already used by ${current}; pick another name`,
			);
		if (model && model !== current) {
			data.reviewers[name] = model;
			wrote.push(`${host.agents ? `agents/reviewer-${name}.md` : `reviewer-${name}`} (${model})`);
		}
	}
	const before = presets[preset] ?? [];
	const joined = [...new Set(entries.map(e => e.name))].filter(n => !before.includes(n));
	presets[preset] = [...before, ...joined];
	const files = host.agents ? renderAgents(data.reviewers) : undefined;
	if (!files) for (const [name, model] of Object.entries(data.reviewers)) checkReviewer(name, model);
	writeData(data);
	if (files) syncAgents(files);
	const members = presets[preset].join(", ");
	const result = isNew
		? `Created preset ${preset}: ${members}`
		: `${preset}: ${joined.map(n => `+${n}`).join(", ") || "no new members"} (now: ${members})`;
	return `${wrote.length ? `${host.agents ? "Wrote" : "Added"} ${wrote.join(", ")}; ` : ""}${result}`;
}

// Removes the reviewers from the preset only; they stay in `reviewers` (and agents/), so they can be added back. A
// preset is never left empty: removing it is "Remove a preset". Everything is checked before the one write.
function rm(host: Host, preset: string, names: string[]): string {
	const data = readData();
	const presets = data.presets[host.id];
	const members = membersOf(presets, preset);
	for (const name of names) if (!members.includes(name)) throw new Error(`"${name}" is not in preset ${preset} (${members.join(", ")})`);
	const left = members.filter(n => !names.includes(n));
	if (!left.length) throw new Error(`${preset} would be empty; use Remove a preset`);
	presets[preset] = left;
	writeData(data);
	return `${preset}: ${members.filter(n => names.includes(n)).map(n => `-${n}`).join(", ")} (now: ${left.join(", ")})`;
}

// Preset picker options (description: the members); no presets is an error with the first-run hint.
function presetOptions(presets: Presets): Row[] {
	if (!Object.keys(presets).length) throw new Error(NO_PRESETS);
	return Object.entries(presets).map(([p, members]) => ({ label: p, description: members.join(", ") }));
}

type Row = { label: string; description?: string };
type SelectOptions = {
	initialIndex?: number;
	selectionMarker?: "checkbox";
	checkedIndices?: number[];
	markableCount?: number;
	helpText?: string;
};
type KeyResult = { data?: string; consume?: boolean } | undefined;
// The context members both hosts provide under the same names.
type Ctx = {
	mode: string;
	hasUI: boolean;
	cwd: string;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		onTerminalInput(handler: (data: string) => KeyResult): () => void;
	};
};
// The members of omp's and pi's ExtensionAPI used here (same names and shapes in both).
type Api = {
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: Ctx) => void): void;
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
	sendUserMessage(message: string, options?: { deliverAs: "followUp" }): void;
	exec(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string; code: number }>;
};
type ModelChoice = { selector: string; id: string; levels: readonly string[] };

// What differs per host; everything else in this file is shared.
type Host = {
	id: "omp" | "pi";
	// omp generates agents/ (its task tool runs the reviewers); pi runs them itself from the template.
	agents: boolean;
	// A select that takes rows with descriptions and the checklist options (omp's own select does).
	select(ctx: Ctx, title: string, options: (string | Row)[], opts?: SelectOptions): Promise<string | undefined>;
	// "Add model": the host's models, `levels` without "(none)".
	models(ctx: Ctx): ModelChoice[];
	review(ctx: Ctx, data: Data, members: string[], scope: string, diff?: string): Promise<void>;
	// Why the host can't run `model` ("<host> can't run it: <reason>"), or undefined. List and Remove mark such
	// reviewers; the reviewer picker hides them.
	unusable(ctx: Ctx, model: string): string | undefined;
};

// `char` typed with no modifier: the plain byte, or its kitty keyboard protocol form (press or repeat, never release;
// Caps Lock and Num Lock ignored), as pi-tui's matchesKey reads an unmodified key.
const isKey = (data: string, char: string) => {
	if (data === char) return true;
	const m = /^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?u$/.exec(data);
	return !!m && Number(m[1]) === char.charCodeAt(0) && ((Number(m[2] ?? "1") - 1) & ~(64 | 128)) === 0 && m[3] !== "3";
};

const HINT = "Space toggles · Enter confirms · Esc cancels";

// A checklist on the host select with the checkbox marker on the rows. In the TUI, Space toggles the row under
// the cursor and Enter confirms the ticked rows (hint in the footer, no Done row): while each select is open a key
// listener turns a lone space into Enter and records that it was a space. Other modes (RPC, ACP) have no terminal
// input, so there Enter toggles and a "Done (<n> selected)" row confirms. A toggle reopens the list on that row;
// "Add model" (only with `addRows`) runs it at once on Enter or Space and its rows join ticked. Returns the ticked
// labels in list order; undefined = cancelled. Hosts that drop the dialog options (ACP) show a plain list (no checked
// state, cursor back on row 0) where the loop still works.
async function pickMany(host: Host, ctx: Ctx, title: string, rows: Row[], addRows?: () => Promise<Row[]>): Promise<string[] | undefined> {
	const spaceMode = ctx.mode === "tui";
	const helpText = addRows ? `${HINT} · Enter on ${ADD_MODEL} opens the model list` : HINT;
	const ticked = new Set<string>();
	let initialIndex = 0;
	let space = false;
	const onKey = (data: string) => ((space = isKey(data, " ")) ? { data: "\r" } : undefined);
	while (true) {
		const done = `Done (${ticked.size} selected)`;
		const checkedIndices = rows.flatMap((r, i) => (ticked.has(r.label) ? [i] : []));
		space = false;
		const off = spaceMode ? ctx.ui.onTerminalInput(onKey) : undefined;
		let choice: string | undefined;
		try {
			choice = await host.select(ctx, title, [...rows, ...(addRows ? [ADD_MODEL] : []), ...(spaceMode ? [] : [done])], {
				initialIndex,
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: rows.length,
				...(spaceMode ? { helpText } : {}),
			});
		} finally {
			off?.();
		}
		if (choice === undefined) return undefined;
		if (choice === ADD_MODEL && addRows) {
			const added = await addRows();
			for (const row of added) {
				if (!rows.some(r => r.label === row.label)) rows.push(row);
				ticked.add(row.label);
			}
			initialIndex = added.length ? rows.findIndex(r => r.label === added[0].label) : rows.length;
			continue;
		}
		const at = rows.findIndex(r => r.label === choice);
		if (choice === done || (at >= 0 && spaceMode && !space)) return rows.map(r => r.label).filter(l => ticked.has(l));
		if (at < 0) continue;
		initialIndex = at;
		if (!ticked.delete(choice)) ticked.add(choice);
	}
}

// The name "Add model" offers for `model` (provider/id[:level]): the derived name, or, when a reviewer (saved or
// pending) already has that name with another model, `<derived>-<provider>`, then `-2`, `-3`... until free. Only
// the default moves aside: a typed name that collides is still refused by add().
function defaultName(derived: string, provider: string, model: string, modelOf: (name: string) => string | undefined): string {
	const free = (name: string) => (modelOf(name) ?? model) === model;
	if (free(derived)) return derived;
	const base = `${derived}-${deriveName(provider)}`;
	let name = base;
	for (let i = 2; !free(name); i++) name = `${base}-${i}`;
	return name;
}

// "Add model": a checklist of the host's models (minus those already pending in `pending`), then for each ticked one
// in list order its thinking level and reviewer name (empty: defaultName). Cancelling the checklist or any of those
// steps drops the whole batch ([]).
async function newReviewers(host: Host, ctx: Ctx, reviewers: Data["reviewers"], pending: Entry[]): Promise<Entry[]> {
	const isPending = (selector: string) => pending.some(e => e.model === selector || e.model?.startsWith(`${selector}:`));
	const models = host.models(ctx).filter(m => !isPending(m.selector));
	const picked = await pickMany(host, ctx, "Add which models?", models.map(m => ({ label: m.selector })));
	const batch: Entry[] = [];
	const modelOf = (name: string) => reviewers[name] ?? [...pending, ...batch].find(e => e.name === name)?.model;
	for (const selector of picked ?? []) {
		const model = models.find(m => m.selector === selector);
		if (!model) return [];
		let level = NO_LEVEL;
		if (model.levels.length) {
			const choice = await ctx.ui.select(`Thinking level for ${selector}`, [NO_LEVEL, ...model.levels]);
			if (!choice) return [];
			level = choice;
		}
		const spec = level === NO_LEVEL ? selector : `${selector}:${level}`;
		const provider = selector.slice(0, -model.id.length - 1);
		const fallback = defaultName(deriveName(model.id), provider, spec, modelOf);
		const name = await ctx.ui.input(`Reviewer name for ${selector} (empty for ${fallback})`, fallback);
		if (name === undefined) return [];
		batch.push({ name: name.trim() || fallback, model: spec });
	}
	return batch;
}

// The reviewers to put in `preset`: the existing ones not yet in it that this host can run, plus any made with "Add
// model" (pending until add() writes them; a name made twice or matching an existing reviewer is checked there).
// undefined = cancelled; [] = nothing ticked.
async function pickReviewers(host: Host, ctx: Ctx, preset: string, { reviewers, presets }: Data): Promise<Entry[] | undefined> {
	const rows = Object.keys(reviewers)
		.filter(n => !presets[host.id][preset]?.includes(n) && !host.unusable(ctx, reviewers[n]))
		.map(n => ({ label: n, description: reviewers[n] }));
	const made: Entry[] = [];
	const names = await pickMany(host, ctx, `Add which reviewers to ${preset}?`, rows, async () => {
		const batch = await newReviewers(host, ctx, reviewers, made);
		made.push(...batch);
		return batch.map(e => ({ label: e.name, description: e.model }));
	});
	if (!names) return undefined;
	const isMade = (name: string) => made.some(e => e.name === name);
	return [...names.filter(n => !isMade(n)).map(name => ({ name })), ...made.filter(e => names.includes(e.name))];
}

// The /creview-config entries (label -> flow, returning the notification text); every write goes through add(), rm()
// or the preset removal below, each validating before writing.
const CONFIG: Record<string, (host: Host, ctx: Ctx) => Promise<string>> = {
	"List presets and reviewers": async (host, ctx) => listText(host, ctx),
	"Create a preset": async (host, ctx) => {
		const data = readData();
		const preset = (await ctx.ui.input("New preset name", "lowercase letters, digits, hyphens"))?.trim();
		if (!preset) return CANCELLED;
		checkPreset(data.presets[host.id], preset, true);
		const picked = await pickReviewers(host, ctx, preset, data);
		return picked ? add(host, ctx, preset, picked, true) : CANCELLED;
	},
	"Remove a preset": async (host, ctx) => {
		const preset = await host.select(ctx, "Remove which preset?", presetOptions(readData().presets[host.id]));
		if (!preset || !(await ctx.ui.confirm(`Remove preset ${preset}?`, "Its reviewers stay available."))) return CANCELLED;
		const data = readData();
		membersOf(data.presets[host.id], preset);
		delete data.presets[host.id][preset];
		writeData(data);
		return `Removed preset ${preset}; its reviewers stay in creview.json`;
	},
	"Add reviewers to a preset": async (host, ctx) => {
		const data = readData();
		const preset = await host.select(ctx, "Add reviewers to which preset?", presetOptions(data.presets[host.id]));
		if (!preset) return CANCELLED;
		const picked = await pickReviewers(host, ctx, preset, data);
		if (!picked) return CANCELLED;
		return picked.length ? add(host, ctx, preset, picked, false) : NOTHING;
	},
	"Remove reviewers from a preset": async (host, ctx) => {
		const { reviewers, presets: allPresets } = readData();
		const presets = allPresets[host.id];
		const preset = await host.select(ctx, "Remove reviewers from which preset?", presetOptions(presets));
		if (!preset) return CANCELLED;
		const members = membersOf(presets, preset);
		if (members.length === 1) throw new Error(`${preset} has one reviewer; use Remove a preset`);
		const row = (n: string) => {
			const why = reviewers[n] === undefined ? undefined : host.unusable(ctx, reviewers[n]);
			return { label: n, description: why ? `${reviewers[n]}  (${why})` : reviewers[n] };
		};
		const names = await pickMany(host, ctx, `Remove which reviewers from ${preset}?`, members.map(row));
		if (!names) return CANCELLED;
		return names.length ? rm(host, preset, names) : NOTHING;
	},
};

// The labels of omp's /review "Review Mode" menu.
const BASE_CHOICE = "1. Review against a base branch (PR Style)";
const UNCOMMITTED_CHOICE = "2. Review uncommitted changes";
const COMMIT_CHOICE = "3. Review a specific commit";
const PR_CHOICE = "4. Review a specific PR/MR";
const CUSTOM_CHOICE = "5. Custom review instructions";

// The git steps and sub-pickers of omp's /review for its local entries, with its messages: the picked base branch or
// commit line ("" for uncommitted changes), undefined when cancelled; a failure (no repository, no branches or
// commits, empty diff) throws.
async function resolveLocal(api: Api, ctx: Ctx, mode: string): Promise<string | undefined> {
	const git = (...args: string[]) => api.exec("git", args, { cwd: ctx.cwd });
	const lines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);
	const failed = (what: string, r: { code: number; stderr: string }) =>
		new Error(`Failed to ${what}: ${lines(r.stderr)[0] ?? `git exited with code ${r.code}`}`);
	if (mode === UNCOMMITTED_CHOICE) {
		// Outside a repository `git diff` falls back to --no-index and prints its usage instead of an error.
		const repo = await git("rev-parse", "--git-dir");
		if (repo.code) throw failed("get diff", repo);
		const checks = [await git("diff", "--quiet"), await git("diff", "--cached", "--quiet")];
		const broken = checks.find(r => r.code !== 0 && r.code !== 1);
		if (broken) throw failed("get diff", broken);
		if (checks.every(r => r.code === 0)) throw new Error("No uncommitted changes found");
		return "";
	}
	if (mode === COMMIT_CHOICE) {
		const log = await git("log", "-n", "20", "--format=%h %s");
		const commits = log.code ? [] : lines(log.stdout);
		if (!commits.length) throw new Error("No commits found");
		const picked = await ctx.ui.select("Select commit to review", commits);
		if (!picked) return undefined;
		const show = await git("show", "--stat", "--format=", picked.split(" ")[0]);
		if (show.code) throw failed("get commit", show);
		if (!show.stdout.trim()) throw new Error("Commit has no diff content");
		return picked;
	}
	const refs = await git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes");
	const branches = refs.code ? [] : lines(refs.stdout).filter(r => !r.endsWith("/HEAD")).map(r => r.replace(/^refs\/(heads|remotes)\//, ""));
	if (!branches.length) throw new Error("No git branches found");
	const base = await ctx.ui.select("Select base branch to compare against", branches);
	if (!base) return undefined;
	const head = (await git("branch", "--show-current")).stdout.trim() || "HEAD";
	const mergeBase = await git("merge-base", base, head);
	if (mergeBase.code === 1) throw new Error(`No common history between ${base} and ${head}`);
	if (mergeBase.code) throw failed("get diff", mergeBase);
	const diff = await git("diff", "--quiet", mergeBase.stdout.trim(), head);
	if (diff.code !== 0 && diff.code !== 1) throw failed("get diff", diff);
	if (diff.code === 0) throw new Error(`No changes between ${base} and ${head}`);
	return base;
}

// The Review Mode menu of omp's /review, turned into the scope of the review prompt and, except for custom
// instructions, the exact way to get its diff. undefined = cancelled; a failure throws with its message.
async function pickScope(api: Api, ctx: Ctx): Promise<{ scope: string; diff?: string } | undefined> {
	const mode = await ctx.ui.select("Review Mode", [BASE_CHOICE, UNCOMMITTED_CHOICE, COMMIT_CHOICE, PR_CHOICE, CUSTOM_CHOICE]);
	if (mode === PR_CHOICE) {
		const ref = (await ctx.ui.input("PR/MR number or URL"))?.trim();
		if (!ref) return undefined;
		const n = ref.match(/^[#!]?(\d+)$/)?.[1];
		const site = URL.canParse(ref) ? new URL(ref).hostname : "";
		const cli = (tool: string, kind: string, id: string) => `\`${tool} ${kind} diff ${id}\` (context: \`${tool} ${kind} view ${id}\`)`;
		const get =
			n ? `Get the diff with ${cli("gh", "pr", n)}; if that fails (not a GitHub repository), use ${cli("glab", "mr", n)}.`
			: site.includes("github") ? `Get the diff with ${cli("gh", "pr", ref)}.`
			: site.includes("gitlab") ? `Get the diff with ${cli("glab", "mr", ref)}.`
			: `Fetch the diff from ${ref}.`;
		return {
			scope: `PR/MR ${n ? `#${n}` : ref}`,
			diff: `${get} A PR/MR is not the local working tree: don't use \`git status\` or \`git diff --stat\`.`,
		};
	}
	if (mode === CUSTOM_CHOICE) {
		const scope = (await ctx.ui.input("Enter custom review instructions"))?.trim();
		return scope ? { scope } : undefined;
	}
	if (mode !== BASE_CHOICE && mode !== UNCOMMITTED_CHOICE && mode !== COMMIT_CHOICE) return undefined;
	const picked = await resolveLocal(api, ctx, mode);
	if (picked === undefined) return undefined;
	if (mode === BASE_CHOICE)
		return {
			scope: `the current branch against ${picked}, PR style (git diff ${picked}...HEAD)`,
			diff: `Get the diff with \`git diff ${picked}...HEAD\` (overview: \`git diff --stat ${picked}...HEAD\`).`,
		};
	if (mode === COMMIT_CHOICE) {
		const hash = picked.split(" ")[0];
		return { scope: `commit ${hash}`, diff: `Get the diff with \`git show ${hash}\` (overview: \`git show --stat ${hash}\`).` };
	}
	return {
		scope: "uncommitted changes (staged and unstaged)",
		diff: "Get the changes with `git status`, `git diff` (unstaged) and `git diff --cached` (staged) (overview: `git diff --stat` and `git diff --cached --stat`).",
	};
}

// The default scope of a typed (or empty) one, for whoever gathers the diff.
const scopeTarget = (scope: string) =>
	`Determine the review scope from \`${scope || "(no arguments)"}\` (default to uncommitted changes against \`HEAD\`, or the current branch against the base branch if the working tree is clean).`;

// The one synthesis instruction of both hosts: how the main agent merges the reviewers' reports.
function synthesis(members: string[]): string {
	const agents = members.map(n => `reviewer-${n}`);
	return `   - Consolidate the outputs from all reviewers (${agents.map(a => `\`${a}\``).join(", ")}).
   - Start with **Consensus Findings** (issues flagged by 2 or more reviewers), naming for each one the reviewers that flagged it (a \`Reviewers\` column or a tag such as \`[${members.join(", ")}]\`).
   - Group all findings by severity (\`P0\` to \`P3\`), tagging each with the reviewer(s) that caught it (e.g., \`[P0][${members.join(", ")}]\`). When only some reviewers flagged an issue, say so; don't merge distinct findings.
   - Conclude with a unified **Verdict** (\`APPROVE\`, \`COMMENT\`, or \`REQUEST_CHANGES\`).`;
}

// omp: the main agent runs the reviewers with its task tool. A typed (or empty) scope leaves the reviewers to determine
// the diff; a scope from the Review Mode menu comes with the exact command (`diff`).
function reviewPrompt(members: string[], scope: string, diff?: string): string {
	const agents = members.map(n => `reviewer-${n}`);
	const target = diff
		? `Review scope: \`${scope}\`.

1. **Gather Diff Context Once**:
   - ${diff} Do this once so all reviewers inspect the exact same change set, and pass the target and these commands to every reviewer.`
		: `${scopeTarget(scope)}

1. **Gather Diff Context Once**:
   - Run \`git status\` and \`git diff --stat\` for the target scope so all reviewers inspect the exact same change set.`;
	return `${target}

2. **Spawn Parallel Reviewers**:
   - In a **single turn**, invoke the \`task\` tool ONCE with ${agents.length} items in \`tasks[]\`, one per reviewer agent below, each item setting \`agent\` to that name and passing the target diff scope and the arguments above:
${agents.map(a => `     - \`${a}\``).join("\n")}

3. **Synthesize & Cross-Validate**:
${synthesis(members)}`;
}

// pi's thinking levels in its order; omp offers the same list (without "off") for reasoning models that name none.
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const ompHost = (api: Api): Host => {
	const omp = (ctx: Ctx) => ctx as unknown as OmpContext;
	const models = (ctx: Ctx): ModelChoice[] =>
		omp(ctx).models.list().map(m => ({
			selector: `${m.provider}/${m.id}`,
			id: m.id,
			levels: m.thinking?.efforts ?? (m.reasoning ? LEVELS.slice(1) : []),
		}));
	return {
		id: "omp",
		agents: true,
		select: (ctx, title, options, opts) => omp(ctx).ui.select(title, options, opts),
		models,
		review: async (_ctx, _data, members, scope, diff) => api.sendUserMessage(reviewPrompt(members, scope, diff)),
		// Like pi's pre-flight (resolveModel): provider/id[:level] must be one of these models, its level one Add model
		// offers (omp itself would clamp it). omp lists only models with credentials, so unknown and logged out look alike.
		unusable: (ctx, spec) => {
			const list = models(ctx);
			if (list.some(m => m.selector === spec)) return undefined;
			const cut = spec.lastIndexOf(":");
			const base = cut > spec.indexOf("/") ? spec.slice(0, cut) : spec;
			const model = list.find(m => m.selector === base);
			if (!model) return `omp can't run it: unknown model "${base}" or no credentials`;
			const level = spec.slice(cut + 1);
			return model.levels.includes(level) ? undefined : `omp can't run it: unsupported thinking level "${level}"`;
		},
	};
};

// pi -----------------------------------------------------------------------------------------------------------------
// pi has no task tool and no agent files: /creview runs every reviewer as a separate `pi` process with the template as
// its prompt, then hands their reports to the main session with the same synthesis instruction as omp.

const pctx = (ctx: Ctx) => ctx as unknown as PiContext;
// The fields of a pi model that decide its thinking levels.
type PiModel = { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> };
const labelOf = (o: string | Row) => (typeof o === "string" ? o : o.label);
const MAX_VISIBLE = 10;

// The levels pi accepts for a model, as pi-ai's getSupportedThinkingLevels: only "off" without reasoning; xhigh and max
// only where the model maps them; a level mapped to null is unsupported.
const piLevels = (m: PiModel) =>
	!m.reasoning ? ["off"] : LEVELS.filter(l => {
		const mapped = m.thinkingLevelMap?.[l];
		return mapped !== null && (mapped !== undefined || (l !== "xhigh" && l !== "max"));
	});

// Styled parts cut to `width` columns (pi stops on a wider line). Every character drawn here takes one column: names,
// models and the fixed texts.
const fit = (width: number, ...parts: [string, ((s: string) => string)?][]) => {
	let room = width;
	let line = "";
	for (const [text, style] of parts) {
		const cut = [...text].slice(0, Math.max(0, room));
		room -= cut.length;
		if (cut.length) line += style ? style(cut.join("")) : cut.join("");
	}
	return line;
};

// pi's select takes plain strings and no options. Rows with a description or checklist options get, in the TUI, a
// custom list that honors them (cursor row, checkbox marks, footer, type-to-search on long lists); in RPC the marks and
// descriptions go into the option text and the choice is mapped back to its label.
async function piSelect(ctx: Ctx, title: string, options: (string | Row)[], opts: SelectOptions = {}): Promise<string | undefined> {
	const { ui } = pctx(ctx);
	if (!opts.selectionMarker && options.every(o => typeof o === "string")) return ui.select(title, options as string[]);
	const mark = (i: number) =>
		opts.selectionMarker === "checkbox" && i < (opts.markableCount ?? options.length) ? (opts.checkedIndices?.includes(i) ? "[x] " : "[ ] ") : "";
	const descOf = (o: string | Row) => (typeof o === "string" ? undefined : o.description);
	if (ctx.mode !== "tui") {
		const texts = options.map((o, i) => `${mark(i)}${labelOf(o)}${descOf(o) ? ` - ${descOf(o)}` : ""}`);
		const choice = await ui.select(title, texts);
		return choice === undefined ? undefined : labelOf(options[texts.indexOf(choice)]);
	}
	return ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const labels = options.map(labelOf);
		const searchable = options.length > MAX_VISIBLE;
		let query = "";
		let cursor = Math.min(Math.max(opts.initialIndex ?? 0, 0), options.length - 1);
		const shown = () => labels.flatMap((l, i) => (!query || l.toLowerCase().includes(query.toLowerCase()) ? [i] : []));
		const accent = (s: string) => theme.fg("accent", s);
		const muted = (s: string) => theme.fg("muted", s);
		return {
			render(width: number): string[] {
				const list = shown();
				const at = Math.max(0, list.indexOf(cursor));
				const start = Math.max(0, Math.min(at - Math.floor(MAX_VISIBLE / 2), list.length - MAX_VISIBLE));
				const rows = list.slice(start, start + MAX_VISIBLE).map(i => {
					const on = i === cursor;
					const desc = descOf(options[i]);
					return fit(width, [" "], [on ? "→ " : "  ", accent], [mark(i)], [labels[i], on ? accent : undefined], [desc ? `  ${desc}` : "", muted]);
				});
				// The frame of pi's own selector: borders, blank rows and a one-column indent.
				const border = fit(width, ["─".repeat(Math.max(1, width)), s => theme.fg("border", s)]);
				return [
					border,
					"",
					fit(width, [" "], [title, s => accent(theme.bold(s))]),
					...(searchable ? [fit(width, [" "], [`Search: ${query}`, muted])] : []),
					"",
					...(rows.length ? rows : [fit(width, ["   No matching rows", muted])]),
					...(list.length > MAX_VISIBLE ? [fit(width, [`   (${at + 1}/${list.length})`, muted])] : []),
					"",
					fit(width, [" "], [opts.helpText ?? "↑↓ navigate · Enter selects · Esc cancels", s => theme.fg("dim", s)]),
					"",
					border,
				];
			},
			handleInput(data: string): void {
				const list = shown();
				const at = list.indexOf(cursor);
				if (keybindings.matches(data, "tui.select.up")) cursor = list[Math.max(0, at - 1)] ?? cursor;
				else if (keybindings.matches(data, "tui.select.down")) cursor = list[Math.min(list.length - 1, at + 1)] ?? cursor;
				else if (keybindings.matches(data, "tui.select.confirm")) return void (list.includes(cursor) && done(labels[cursor]));
				else if (keybindings.matches(data, "tui.select.cancel")) return void done(undefined);
				else if (searchable && keybindings.matches(data, "tui.editor.deleteCharBackward")) query = query.slice(0, -1);
				else if (searchable && data.length === 1 && data > " ") query += data;
				else return;
				const next = shown();
				if (!next.includes(cursor)) cursor = next[0] ?? cursor;
				tui.requestRender();
			},
			invalidate() {},
		};
	});
}

type Resolved = { selector: string; level?: string } | { reason: string };

// A creview.json model as pi runs it: provider/id must be in pi's registry with credentials, and a :level suffix must
// be one of the model's pi thinking levels (no clamping, so a reviewer never silently runs at another level).
function resolveModel(ctx: PiContext, spec: string): Resolved {
	const registry = ctx.modelRegistry;
	const provider = spec.slice(0, spec.indexOf("/"));
	let id = spec.slice(provider.length + 1);
	let level: string | undefined;
	let model = registry.find(provider, id);
	if (!model && id.includes(":")) {
		level = id.slice(id.lastIndexOf(":") + 1);
		id = id.slice(0, id.lastIndexOf(":"));
		model = registry.find(provider, id);
	}
	if (!model) return { reason: `unknown model "${provider}/${id}"` };
	if (level && !piLevels(model).includes(level)) return { reason: `unsupported thinking level "${level}"` };
	if (!registry.hasConfiguredAuth(model)) return { reason: `no credentials for provider "${provider}"` };
	return { selector: `${provider}/${id}`, level };
}

const TOOLS = "read,grep,find,ls,bash";
const TIMEOUT_MINUTES = 20;
// The template is written for omp's task agents; a pi child has no yield tool, so its answer is the report.
const PI_OUTPUT = `In this session there is no \`yield\` tool and no idle finalization: ignore those instructions and write your whole result as your final answer, in plain text. List each finding with its priority (P0 to P3), title, file path and line range, confidence and one-paragraph body; then \`overall_correctness\` (correct or incorrect), a 1-3 sentence explanation and your confidence. Use bash for read-only commands only.`;

// pi's own CLI on the running runtime: the launcher (pi.cmd on Windows) can't be spawned without a shell. A compiled
// pi binary is its own CLI, and its argv[1] is a virtual path.
function piCommand(): [string, string[]] {
	const script = process.argv[1];
	if (script && !/^\/\$bunfs\/|^[A-Za-z]:[\\/]~BUN[\\/]/.test(script) && fs.existsSync(script)) return [process.execPath, [script]];
	return /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath)) ? ["pi", []] : [process.execPath, []];
}

type Outcome = { report?: string; error?: string };

// One reviewer in a `pi --mode json -p` child: its report is the text of the last assistant message. A crash, a
// provider error, a timeout or the abort is the error instead.
function runReviewer(cwd: string, selector: string, level: string | undefined, system: string, task: string, signal: AbortSignal): Promise<Outcome> {
	const [command, prefix] = piCommand();
	const args = [...prefix, "--mode", "json", "-p", "--no-session", "--model", selector, ...(level ? ["--thinking", level] : [])];
	// The user's skills, templates and extensions (creview included) could override the reviewer prompt and its output format.
	args.push("--no-extensions", "--no-skills", "--no-prompt-templates");
	args.push("--tools", TOOLS, "--append-system-prompt", system, task);
	const { promise, resolve } = Promise.withResolvers<Outcome>();
	let report = "";
	let failure: string | undefined;
	let stopped: string | undefined;
	let stderr = "";
	let buffer = "";
	const onLine = (line: string) => {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
		const { content, stopReason, errorMessage } = event.message;
		report = (Array.isArray(content) ? content : []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim();
		failure = stopReason === "error" || stopReason === "aborted" ? errorMessage || `stopped (${stopReason})` : undefined;
	};
	const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const stop = (why: string) => {
		stopped ??= why;
		proc.kill();
	};
	const onAbort = () => stop("cancelled");
	const timer = setTimeout(() => stop(`timed out after ${TIMEOUT_MINUTES} minutes`), TIMEOUT_MINUTES * 60_000);
	let settled = false;
	const finish = (outcome: Outcome) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		resolve(outcome);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		const lines = (buffer + chunk).split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	proc.on("error", err => finish({ error: `could not start pi: ${err.message}` }));
	proc.on("close", code => {
		if (buffer.trim()) onLine(buffer);
		const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(-400);
		if (stopped || failure) return finish({ error: stopped ?? failure });
		if (code !== 0) return finish({ error: `pi exited with code ${code}${tail ? `: ${tail}` : ""}` });
		finish(report ? { report } : { error: "empty final answer" });
	});
	if (signal.aborted) onAbort();
	return promise;
}

const piHost = (api: Api): Host => {
	let active: AbortController | undefined;
	api.on("session_shutdown", () => active?.abort());
	return {
		id: "pi",
		agents: false,
		select: piSelect,
		models: ctx => {
			const models = pctx(ctx).modelRegistry.getAvailable();
			if (!models.length) throw new Error("pi has no model with credentials. Run /login or set a provider API key, then try again.");
			return models.map(m => ({ selector: `${m.provider}/${m.id}`, id: m.id, levels: piLevels(m).filter(l => l !== "off") }));
		},
		review: async (ctx, { reviewers }, members, scope, diff) => {
			const c = pctx(ctx);
			const system = `${readTemplate().replace(/^---\n[\s\S]*?\n---\n/, "").trim()}\n\n${PI_OUTPUT}`;
			const ready: { name: string; spec: string; selector: string; level?: string }[] = [];
			const skipped: string[] = [];
			for (const name of members) {
				const spec = reviewers[name];
				const resolved: Resolved = spec === undefined ? { reason: "unknown reviewer" } : resolveModel(c, spec);
				if ("reason" in resolved) skipped.push(`reviewer-${name} (${resolved.reason})`);
				else ready.push({ name, spec, ...resolved });
			}
			if (!ready.length) return ctx.ui.notify(`No reviewer of this preset can run in pi: ${skipped.join(", ")}`, "error");
			const names = ready.map(r => `reviewer-${r.name}`).join(", ");
			if (skipped.length) ctx.ui.notify(`Skipping reviewers pi can't run: ${skipped.join(", ")}. Running ${names}.`, "warning");
			// The command has cleared the editor and the chat stays empty until the first report: say that work started.
			const esc = ctx.mode === "tui" ? " Esc cancels." : "";
			ctx.ui.notify(ready.length === 1 ? `Running 1 reviewer: ${names}.${esc}` : `Running ${ready.length} reviewers in parallel: ${names}.${esc}`, "info");

			const task = diff
				? `Review scope: \`${scope}\`.\n\n${diff}`
				: `${scopeTarget(scope)}\n\nRun \`git status\` and \`git diff --stat\` for the target scope, then read the diff.`;
			const controller = new AbortController();
			active = controller;
			let finished = 0;
			const status = () =>
				c.ui.setStatus("creview", `creview: ${finished}/${ready.length} reviewers done${ctx.mode === "tui" ? " · Esc cancels" : ""}`);
			status();
			// A command runs while pi is idle, so Esc has no turn to abort: here it stops the reviewers.
			const offEsc = ctx.mode === "tui" ? ctx.ui.onTerminalInput(data => (isKey(data, "\x1b") ? (controller.abort(), { consume: true }) : undefined)) : undefined;
			let results: (typeof ready[number] & Outcome)[];
			try {
				results = await Promise.all(
					ready.map(async r => {
						const outcome = await runReviewer(ctx.cwd, r.selector, r.level, system, task, controller.signal);
						finished++;
						status();
						return { ...r, ...outcome };
					}),
				);
			} finally {
				offEsc?.();
				c.ui.setStatus("creview", undefined);
				active = undefined;
			}
			if (controller.signal.aborted) return ctx.ui.notify(CANCELLED, "info");
			const done = results.filter(r => r.report);
			const failed = results.filter(r => !r.report).map(r => `reviewer-${r.name} (${r.error})`);
			if (!done.length) return ctx.ui.notify(`Every reviewer failed: ${failed.join(", ")}`, "error");

			const coverage = [
				`- Reported: ${done.map(r => `\`reviewer-${r.name}\` (${r.spec})`).join(", ")}.`,
				...(failed.length ? [`- Failed (no report): ${failed.join(", ")}.`] : []),
				...(skipped.length ? [`- Skipped (pi can't run their model): ${skipped.join(", ")}.`] : []),
				...(failed.length || skipped.length
					? ["Say in the report which reviewers failed or were skipped, so it doesn't imply that the whole preset reviewed the change."]
					: []),
			];
			const reports = done.map(r => `<report reviewer="reviewer-${r.name}" model="${r.spec}">\n${r.report}\n</report>`);
			const message = `Review scope: \`${scope || "(no arguments)"}\`.

The reviewers below already reviewed this scope, each in a separate pi process told to change nothing; their reports follow. Don't run them again.
${coverage.join("\n")}

${reports.join("\n\n")}

**Synthesize & Cross-Validate**:
${synthesis(done.map(r => r.name))}`;
			api.sendUserMessage(message, c.isIdle() ? undefined : { deliverAs: "followUp" });
		},
		unusable: (ctx, model) => {
			const resolved = resolveModel(pctx(ctx), model);
			return "reason" in resolved ? `pi can't run it: ${resolved.reason}` : undefined;
		},
	};
};

// `api` is omp's or pi's ExtensionAPI. omp's carries its injected schema builders (`arktype`); pi's has none.
export default function creview(api: Api): void {
	const host = "arktype" in api ? ompHost(api) : piHost(api);
	// agents/ is generated: bring it in line with creview.json and the template at every session start.
	if (host.agents)
		api.on("session_start", (_event, ctx) => {
			try {
				syncAgents(renderAgents(readData().reviewers));
			} catch (err) {
				ctx.ui.notify(`creview: agents/ not synced: ${errorText(err)}`, "error");
			}
		});
	// Every handler: trimmed arguments in, errors out as notifications.
	const run = (body: (args: string, ctx: Ctx) => unknown) => async (typed: string, ctx: Ctx) => {
		try {
			await body(typed.trim(), ctx);
		} catch (err) {
			ctx.ui.notify(errorText(err), "error");
		}
	};

	// No getArgumentCompletions: a preselected completion would take Enter from the bare command (the picker).
	api.registerCommand("creview", {
		description: "Run a code review with a preset: [<preset> [scope and instructions]] (missing parts: pick from menus)",
		handler: run(async (args, ctx) => {
			const data = readData();
			const presets = data.presets[host.id];
			if (!Object.keys(presets).length) return ctx.ui.notify(NO_PRESETS, "error");
			if (!args && !ctx.hasUI) return ctx.ui.notify(REVIEW_USAGE, "error");
			const preset = args.split(/\s+/)[0] || (await host.select(ctx, "Review with which preset?", presetOptions(presets)));
			if (!preset) return ctx.ui.notify(CANCELLED, "info");
			if (!presets[preset]?.length) return ctx.ui.notify(`Unknown preset "${preset}". Available: ${Object.keys(presets).join(", ")}`, "error");
			const typed = args.slice(preset.length).trim();
			const picked: { scope: string; diff?: string } | undefined = typed || !ctx.hasUI ? { scope: typed } : await pickScope(api, ctx);
			if (!picked) return ctx.ui.notify(CANCELLED, "info");
			await host.review(ctx, data, presets[preset], picked.scope, picked.diff);
		}),
	});

	// Menu only; without a UI it can only list.
	api.registerCommand("creview-config", {
		description: "Manage the review presets: list, create or remove a preset, add or remove reviewers (menu)",
		handler: run(async (args, ctx) => {
			if (args) return ctx.ui.notify("Usage: /creview-config (no arguments; opens a menu)", "error");
			if (!ctx.hasUI) return ctx.ui.notify(listText(host, ctx), "info");
			const action = await ctx.ui.select("creview config", Object.keys(CONFIG));
			ctx.ui.notify(action && Object.hasOwn(CONFIG, action) ? await CONFIG[action](host, ctx) : CANCELLED, "info");
		}),
	});
}
