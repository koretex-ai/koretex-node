// `koretex models` — let a provider add or remove models to serve, AFTER the first install.
//
//   koretex models            interactive picker: shows what fits this Mac, pull the ones you want
//   koretex models ls         list installed models + what else this Mac can run
//   koretex models add <tag…> pull one or more models from the catalog
//   koretex models rm  <tag…> delete one or more models
//
// Pulls go through the SAME managed engine the agent serves from (POST /api/pull), so a model is
// live the moment it finishes. After any change we kick the launchd agent so it re-registers its
// new model list with the dispatcher (registration only sends `models` on connect — see index.ts).

import { execSync } from "node:child_process";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:11434";
// HTTPS dispatcher (the `koretex` wrapper sets KORETEX_DISPATCHER; fall back to prod).
const DISPATCHER = (process.env.KORETEX_DISPATCHER ?? "https://dispatcher.koretex.ai").replace(/\/$/, "");
const AGENT_LABEL = "com.koretex.node-agent";
const CREDITS_PER_USDC = 10000; // peg for showing $/1M (display only — billing uses the dispatcher's live peg)

interface CatalogRow {
  tag: string; name: string; sizeGb: number; type: string; minRamGb: number; caps: string[];
  pointsWeight: number; // v2 points multiplier (heavier models earn more per token)
  creditsPerMTok: number; // customer price you earn from
}

/** Total + free unified memory / disk for this Mac, to flag what fits. */
function hardware(): { ramGb: number; freeGb: number } {
  const ramGb = Math.round(os.totalmem() / 1024 ** 3) || 0;
  let freeGb = 0;
  try {
    const out = execSync(`df -g "${os.homedir()}"`, { encoding: "utf8" }).trim().split("\n").pop() ?? "";
    freeGb = Number(out.trim().split(/\s+/)[3]) || 0; // 4th column = available GB
  } catch {
    /* best-effort */
  }
  return { ramGb, freeGb };
}

/** Does a model physically fit? Mirrors the dispatcher's filter (10GB headroom for context + OS). */
function fits(m: CatalogRow, hw: { ramGb: number; freeGb: number }): boolean {
  return m.minRamGb <= hw.ramGb && m.sizeGb + 10 <= hw.freeGb;
}

/** The full curated catalog (unfiltered) as parsed rows. */
async function fetchCatalog(): Promise<CatalogRow[]> {
  const r = await fetch(`${DISPATCHER}/models/catalog?format=text`);
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  const text = await r.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [tag, name, size, type, minram, caps, weight, credits] = l.split("|");
      return {
        tag,
        name: name || tag,
        sizeGb: Number(size) || 0,
        type: type || "text",
        minRamGb: Number(minram) || 0,
        caps: (caps ?? "").split(",").filter(Boolean),
        pointsWeight: Number(weight) || 1,
        creditsPerMTok: Number(credits) || 0,
      };
    });
}

/** Models the local engine currently has (these are exactly what the node serves). */
async function installedModels(): Promise<string[]> {
  try {
    const j: any = await (await fetch(`${ENGINE_URL}/v1/models`)).json();
    return (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

const pays = (m: CatalogRow) =>
  `×${m.pointsWeight.toFixed(2)} pts` + (m.creditsPerMTok ? ` · $${(m.creditsPerMTok / CREDITS_PER_USDC).toFixed(2)}/1M` : "");

const fmtRow = (m: CatalogRow) =>
  `${m.name.padEnd(28)} [${m.type.padEnd(4)}] ~${m.sizeGb}GB` +
  (m.caps.length ? `  ·  ${m.caps.join(", ")}` : "") +
  `  ·  ${pays(m)}  (needs ${m.minRamGb}GB)`;

/** Stream a pull through the managed engine, rendering one updating progress line. */
async function pull(tag: string): Promise<boolean> {
  stdout.write(`\n⬇️  Pulling ${tag} …\n`);
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tag, stream: true }),
    });
  } catch (e: any) {
    stdout.write(`  ✗ engine not reachable (${e?.message ?? e}). Is the node running?  koretex status\n`);
    return false;
  }
  if (!res.ok || !res.body) {
    stdout.write(`  ✗ pull failed (HTTP ${res.status}). Check the tag is a real Ollama model.\n`);
    return false;
  }
  let buf = "";
  let lastPct = -1;
  let ok = false;
  for await (const chunk of res.body as any) {
    buf += Buffer.from(chunk).toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.error) {
        stdout.write(`\n  ✗ ${ev.error}\n`);
        return false;
      }
      if (ev.total && ev.completed != null) {
        const pct = Math.floor((ev.completed / ev.total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          const gb = (ev.total / 1024 ** 3).toFixed(1);
          stdout.write(`\r  ${String(pct).padStart(3)}%  of ${gb}GB  (${ev.status ?? "downloading"})        `);
        }
      } else if (ev.status) {
        stdout.write(`\r  ${ev.status}                                   `);
      }
      if (ev.status === "success") ok = true;
    }
  }
  stdout.write(ok ? `\r  ✓ ${tag} ready.                                   \n` : `\r  (pull ended without success)\n`);
  return ok;
}

/** Remove a model from the engine. */
async function remove(tag: string): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tag }),
    });
    if (res.ok) {
      stdout.write(`  ✓ removed ${tag}\n`);
      return true;
    }
    stdout.write(`  ✗ couldn't remove ${tag} (HTTP ${res.status}) — is it installed?\n`);
    return false;
  } catch (e: any) {
    stdout.write(`  ✗ engine not reachable (${e?.message ?? e})\n`);
    return false;
  }
}

/** Kick the running agent so it reconnects and re-registers its new model list. No-op if stopped. */
function nudgeAgent(): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  try {
    execSync(`launchctl kickstart -k gui/${uid}/${AGENT_LABEL}`, { stdio: "ignore" });
    stdout.write("  ↻ told the node to re-register its models with the network.\n");
  } catch {
    stdout.write("  (node is stopped — your new models register next time you run `koretex start`.)\n");
  }
}

async function listAll(): Promise<void> {
  const hw = hardware();
  const [catalog, installed] = await Promise.all([fetchCatalog().catch(() => [] as CatalogRow[]), installedModels()]);
  // Engine ids come back lowercased (Ollama normalizes, incl. hf.co/* tags) — compare case-insensitively.
  const have = new Set(installed.map((t) => t.toLowerCase()));
  stdout.write(`\nYour Mac:  ${hw.ramGb}GB memory · ${hw.freeGb}GB free disk\n`);
  stdout.write(`\nServing now (${installed.length}):\n`);
  stdout.write(installed.length ? installed.map((t) => `  ✓ ${t}`).join("\n") + "\n" : "  (none yet)\n");
  const addable = catalog.filter((m) => !have.has(m.tag.toLowerCase()) && fits(m, hw));
  const tooBig = catalog.filter((m) => !have.has(m.tag.toLowerCase()) && !fits(m, hw));
  if (addable.length) {
    stdout.write(`\nAlso runnable on this Mac — add with \`koretex models add <tag>\` (higher ×pts / $ = prioritize):\n`);
    addable.sort((a, b) => b.pointsWeight - a.pointsWeight); // highest-paying first
    addable.forEach((m) => stdout.write(`  + ${m.tag.padEnd(22)} ${fmtRow(m)}\n`));
  }
  if (tooBig.length) {
    stdout.write(`\nIn the catalog but need a bigger Mac:\n`);
    tooBig.forEach((m) => stdout.write(`  · ${m.tag.padEnd(22)} needs ${m.minRamGb}GB / ${m.sizeGb + 10}GB free\n`));
  }
  stdout.write("\n");
}

async function addTags(tags: string[]): Promise<void> {
  let changed = false;
  for (const t of tags) if (await pull(t)) changed = true;
  if (changed) nudgeAgent();
}

async function rmTags(tags: string[]): Promise<void> {
  let changed = false;
  for (const t of tags) if (await remove(t)) changed = true;
  if (changed) nudgeAgent();
}

async function interactive(): Promise<void> {
  const hw = hardware();
  const [catalog, installed] = await Promise.all([fetchCatalog().catch(() => [] as CatalogRow[]), installedModels()]);
  const have = new Set(installed.map((t) => t.toLowerCase())); // engine ids are lowercased
  const choices = catalog.filter((m) => !have.has(m.tag.toLowerCase()) && fits(m, hw));
  stdout.write(`\nYour Mac:  ${hw.ramGb}GB memory · ${hw.freeGb}GB free disk\n`);
  stdout.write(`Serving now: ${installed.length ? installed.join(", ") : "(none)"}\n`);
  if (!choices.length) {
    stdout.write("\nNothing more this Mac can add right now (everything that fits is already installed).\n");
    return;
  }
  stdout.write(`\nModels you can add (coding · reasoning · agentic tool calling):\n`);
  stdout.write(`  ×pts = points multiplier · $/1M = what you earn — higher = prioritize.\n`);
  choices.sort((a, b) => b.pointsWeight - a.pointsWeight); // highest-paying first
  choices.forEach((m, i) => stdout.write(`  ${String(i + 1).padStart(2)}) ${fmtRow(m)}\n`));
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question("\nAdd which? (numbers like `1,3`, or Enter to cancel): ")).trim();
  rl.close();
  if (!ans) {
    stdout.write("Cancelled — nothing changed.\n");
    return;
  }
  const picks = ans
    .split(/[\s,]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length)
    .map((n) => choices[n - 1].tag);
  if (!picks.length) {
    stdout.write("No valid choices — nothing changed.\n");
    return;
  }
  await addTags(picks);
}

/** Entry point for `koretex models [ls|add|rm] …`. */
export async function manageModels(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  try {
    if (!sub) return await interactive();
    if (sub === "ls" || sub === "list") return await listAll();
    if (sub === "add" || sub === "pull") {
      if (!rest.length) return stdout.write("Usage: koretex models add <tag> [<tag>…]\n"), void 0;
      return await addTags(rest);
    }
    if (sub === "rm" || sub === "remove" || sub === "delete") {
      if (!rest.length) return stdout.write("Usage: koretex models rm <tag> [<tag>…]\n"), void 0;
      return await rmTags(rest);
    }
    stdout.write(`Unknown: koretex models ${sub}\n  Try: koretex models | koretex models ls | koretex models add <tag> | koretex models rm <tag>\n`);
  } catch (e: any) {
    stdout.write(`models: ${e?.message ?? e}\n`);
  }
}
