#!/usr/bin/env node
// public-guard: 公開リポジトリに、外に出さない語 (所属組織の名前やリポジトリ名、顧客名、社内の名前など) を出さないガード。
// 仕様: docs/public-guard/spec.md (マーケットのリポジトリ)
//
// 入口:
//   (引数なし)                PreToolUse フック (Claude Code の Bash|PowerShell、Codex の Bash)。標準入力の JSON を読む
//   init                      一覧の置き場所と、空の一覧のひな形を作る (既にあれば触らない)
//   refresh                   自動の一覧 (所属組織の名前とそのリポジトリ名) を gh で作り直す
//   audit [--repo o/r] [--repo-dir <dir>]   公開リポジトリに語が残っていないかを報告する (直さない)
//   doctor                    ガードの状態を報告する
//   selftest                  フックが本物の経路で効くかを試すためのコマンドを出す
//   codex-install             スクリプトを一覧の置き場所に写し、Codex のフックに登録する
//
// 語の一覧は ~/.config/public-guard/ にだけ置く。このスクリプトには語を書かない。
// 検査を飛ばすフラグや環境変数は無い (PUBLIC_GUARD_HOME・PUBLIC_GUARD_GH はフックのプロセスの環境変数で、
// コマンドの文からは変えられない。テストのためだけにある)。

import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const HOME = os.homedir();
const CONFIG = process.env.PUBLIC_GUARD_HOME || path.join(HOME, ".config", "public-guard");
const GH = process.env.PUBLIC_GUARD_GH || "gh";
const VIS_TTL_MS = 60 * 60 * 1000;
const AUTO_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HITS_SHOWN = 15;
const BUF = 512 * 1024 * 1024;
const MIN_NODE_MAJOR = 20;
// 試し語: どの一覧にも書かずに、いつも止める語。doctor が本物の経路を確かめるのに使う。
// ソースや文書にそのまま書くと、このプラグインのリポジトリ自身へのコミットが止まるので、組み立てて作る。
const CANARY = ["public", "guard", "canary", "7f3a"].join("-");

// ---------- 小道具 ----------

function log(msg) {
  try {
    fs.mkdirSync(CONFIG, { recursive: true });
    fs.appendFileSync(path.join(CONFIG, "public-guard.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: BUF,
  });
}

function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return null; }
}

function gh(args, { timeout = 15000 } = {}) {
  const r = spawnSync(GH, args, { encoding: "utf8", timeout, maxBuffer: BUF, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function readList(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch { return null; }
}

const lower = (s) => s.toLowerCase();
const unquote = (s) => s.replace(/^["']|["']$/g, "");
const toNativePath = (p) => p.replace(/^\/([a-z])\//i, "$1:/").replace(/^~(?=\/|\\|$)/, HOME);

function readTextFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch { return null; }
}

// ---------- 外に出さない語 ----------

function compileTerm(raw) {
  if (raw.startsWith("re:")) {
    const src = raw.slice(3);
    try { return { label: raw, re: new RegExp(src, "giu") }; } catch {}
    try { return { label: raw, re: new RegExp(src, "gi") }; } catch { log(`bad regex: ${src}`); return null; }
  }
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 英数字の語は語の区切りで照らす。日本語などを含む語は部分一致で照らす。
  const ascii = /^[\x00-\x7f]+$/.test(raw);
  const src = ascii ? `(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])` : esc;
  return { label: raw, re: new RegExp(src, "giu") };
}

// 一覧に語が 1 つも無ければ null を返す (「一覧が無い」として扱う)。試し語はいつも末尾に足す
function loadTerms() {
  const deny = readList(path.join(CONFIG, "deny.txt"));
  const auto = readList(path.join(CONFIG, "auto.txt"));
  if (!deny?.length && !auto?.length) return null;
  const exclude = new Set((readList(path.join(CONFIG, "exclude.txt")) || []).map(lower));
  const raws = [...(deny || []), ...(auto || []).filter((t) => !exclude.has(lower(t))), CANARY];
  const seen = new Set();
  const terms = [];
  for (const r of raws) {
    if (seen.has(lower(r))) continue;
    seen.add(lower(r));
    const t = compileTerm(r);
    if (t) terms.push(t);
  }
  return terms;
}

function scanText(terms, text, where, hits) {
  for (const t of terms) {
    t.re.lastIndex = 0;
    let m;
    while ((m = t.re.exec(text))) {
      hits.push({ term: t.label, match: m[0], where });
      if (m[0] === "") t.re.lastIndex++;
    }
  }
}

function scanLines(terms, text, prefix, hits) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => scanText(terms, line, `${prefix}:${i + 1}`, hits));
}

function loadOrgs() {
  return new Set((readList(path.join(CONFIG, "orgs.txt")) || []).map(lower));
}

function allowSet(key) {
  if (!key) return new Set();
  const f = path.join(CONFIG, "allow", key.replace("/", "__") + ".txt");
  return new Set((readList(f) || []).map(lower));
}

// ---------- 差分 ----------

// unified diff から追加された行だけを取り出す
function addedLines(diff) {
  const out = [];
  let file = null;
  let n = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) { file = null; continue; }
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^"?b\//, "").replace(/"$/, "");
      continue;
    }
    if (l.startsWith("--- ")) continue;
    if (l.startsWith("@@")) {
      const m = /\+(\d+)/.exec(l);
      n = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file) continue;
    if (l.startsWith("+")) { out.push({ file, line: n, text: l.slice(1) }); n++; }
    else if (l.startsWith(" ")) n++;
  }
  return out;
}

function scanDiff(terms, diff, prefix, hits) {
  for (const a of addedLines(diff)) scanText(terms, a.text, `${prefix}${a.file}:${a.line}`, hits);
}

const LOG_SEP = "\x1e";
const MSG_END = "\x1f";

// git log -p の範囲を、コミットごとのメッセージと追加行で照らす
function scanLog(terms, top, rangeArgs, hits) {
  const out = git(top, ["log", "-p", "--no-color", "--no-ext-diff", "-U0", `--format=${LOG_SEP}%H%n%B${MSG_END}`, ...rangeArgs]);
  for (const chunk of out.split(LOG_SEP)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const sha = chunk.slice(0, nl).trim();
    const short = sha.slice(0, 7);
    const end = chunk.indexOf(MSG_END);
    const msg = chunk.slice(nl + 1, end < 0 ? undefined : end);
    scanText(terms, msg, `コミット ${short} のメッセージ`, hits);
    if (end >= 0) scanDiff(terms, chunk.slice(end + 1), `コミット ${short} `, hits);
  }
}

// ---------- コマンドの読み取り ----------

const GIT_PRE = String.raw`\bgit(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?))*\s+`;
const RE_COMMIT = new RegExp(GIT_PRE + String.raw`commit\b`);
const RE_PUSH = new RegExp(GIT_PRE + String.raw`push\b`);
const RE_GH_TEXT = /\bgh\s+(?:(?:pr|issue)\s+(?:create|edit|comment|review|merge|close|reopen)|release\s+(?:create|edit))\b/;
const RE_GH_API = /\bgh\s+api\b/;
const RE_GH_API_WRITE = /(?:-X\s*|--method[=\s]+)(?:POST|PATCH|PUT)\b|\s(?:-f|-F|--field|--raw-field|--input)(?=[\s=])/i;
const RE_GIST = /\bgh\s+gist\s+create\b/;
const RE_REPO_CREATE_PUBLIC = /\bgh\s+repo\s+create\b[^\n;&|]*--public\b/;
const RE_REPO_EDIT_PUBLIC = /\bgh\s+repo\s+edit\b[^\n;&|]*--visibility[=\s]+public\b/i;

// 引用符を考えて空白で区切る
function tokenize(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function segmentAfter(cmd, re) {
  const m = re.exec(cmd);
  if (!m) return "";
  return cmd.slice(m.index + m[0].length).split(/(?:&&|\|\||[;|\n])/)[0];
}

function resolveCwd(cmd, baseCwd) {
  let cwd = baseCwd || process.cwd();
  const cM = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  const cdM = /(?:^|[;&|\n]\s*)(?:cd|Set-Location|pushd|Push-Location)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(cmd);
  const dir = cM?.[1] ?? cdM?.[1];
  if (dir) cwd = path.resolve(cwd, toNativePath(unquote(dir)));
  return cwd;
}

function repoTop(cwd) {
  const t = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return t ? t.trim() : null;
}

function ownerRepoOf(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function remotes(top) {
  return (tryGit(top, ["remote"]) || "").split(/\r?\n/).filter(Boolean);
}

function remoteUrl(top, remote) {
  const u = tryGit(top, ["remote", "get-url", remote]);
  return u ? u.trim() : null;
}

// ---------- 公開の判定 ----------

function readVisCache() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG, "visibility-cache.json"), "utf8")); } catch { return {}; }
}

function writeVisCache(c) {
  try {
    fs.mkdirSync(CONFIG, { recursive: true });
    fs.writeFileSync(path.join(CONFIG, "visibility-cache.json"), JSON.stringify(c));
  } catch {}
}

// "PUBLIC" | "PRIVATE" | "INTERNAL" | null (分からない)
function visibilityOf(ownerRepo) {
  const key = lower(ownerRepo);
  const cache = readVisCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < VIS_TTL_MS) return hit.visibility;
  const out = gh(["repo", "view", ownerRepo, "--json", "visibility", "-q", ".visibility"], { timeout: 8000 });
  const vis = out ? out.trim().toUpperCase() : null;
  if (vis) {
    cache[key] = { visibility: vis, at: Date.now() };
    writeVisCache(cache);
  }
  return vis;
}

// 検査が要るか。組織のリポジトリと非公開は要らない。分からなければ要る。
function needsCheck(ownerRepo, orgs) {
  if (!ownerRepo) return true;
  if (orgs.has(lower(ownerRepo.split("/")[0]))) return false;
  const vis = visibilityOf(ownerRepo);
  return !(vis === "PRIVATE" || vis === "INTERNAL");
}

// ---------- 操作ごとの検査 ----------

function commitChecks(cmd, cwd, orgs) {
  const top = repoTop(cwd);
  if (!top) return null;
  const rs = remotes(top);
  if (!rs.length) return null; // リモートが無ければ外へ出ない
  const remote = rs.includes("origin") ? "origin" : rs[0];
  const target = ownerRepoOf(remoteUrl(top, remote));
  if (!needsCheck(target, orgs)) return null;
  return {
    target,
    collect(terms, hits) {
      scanText(terms, cmd, "コマンドの文", hits);
      const seg = segmentAfter(cmd, RE_COMMIT);
      const toks = tokenize(seg);
      toks.forEach((t, i) => {
        let f = null;
        if (t === "-F" || t === "--file") f = toks[i + 1];
        else if (t.startsWith("--file=")) f = t.slice(7);
        if (f && f !== "-") {
          const p = path.resolve(cwd, toNativePath(f));
          const txt = readTextFile(p);
          if (txt != null) scanLines(terms, txt, `ファイル ${f}`, hits);
        }
      });
      const wide = /\bgit\b[^\n;&|]*\badd\b/.test(cmd) || /\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)(?=\s|$)/.test(" " + seg);
      if (wide) {
        let d = tryGit(top, ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U0"]);
        if (d == null) d = (tryGit(top, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U0"]) || "") + "\n" + (tryGit(top, ["diff", "--no-color", "--no-ext-diff", "-U0"]) || "");
        scanDiff(terms, d, "", hits);
        const untracked = (tryGit(top, ["ls-files", "--others", "--exclude-standard", "-z"]) || "").split("\0").filter(Boolean);
        for (const f of untracked) {
          const txt = readTextFile(path.join(top, f));
          if (txt != null) scanLines(terms, txt, f, hits);
        }
      } else {
        scanDiff(terms, git(top, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U0"]), "", hits);
      }
    },
  };
}

function pushChecks(cmd, cwd, orgs) {
  const seg = segmentAfter(cmd, RE_PUSH);
  const toks = tokenize(seg);
  if (toks.some((t) => t === "--delete" || t === "-d")) return null;
  const top = repoTop(cwd);
  if (!top) return null;
  const rs = remotes(top);
  const args = toks.filter((t) => !t.startsWith("-"));
  let remote = null;
  let url = null;
  let refspec = null;
  if (args.length) {
    if (rs.includes(args[0])) remote = args[0];
    else if (/[:/]/.test(args[0]) && /github\.com|^git@|^https?:/.test(args[0])) url = args[0];
    refspec = args[1] ?? null;
    if (!remote && !url) refspec = args[0];
  }
  if (!remote && !url) {
    const br = (tryGit(top, ["branch", "--show-current"]) || "").trim();
    const up = br ? tryGit(top, ["config", `branch.${br}.remote`]) : null;
    remote = up?.trim() || (rs.includes("origin") ? "origin" : rs[0]) || null;
  }
  if (refspec && refspec.startsWith(":")) return null; // 削除の push
  const target = ownerRepoOf(url || (remote ? remoteUrl(top, remote) : null));
  if (!needsCheck(target, orgs)) return null;
  let src = "HEAD";
  if (refspec) {
    const s = refspec.replace(/^\+/, "").split(":")[0];
    if (s && tryGit(top, ["rev-parse", "--verify", "--quiet", `${s}^{commit}`])) src = s;
  }
  return {
    target,
    collect(terms, hits) {
      scanText(terms, cmd, "コマンドの文", hits);
      if (!tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"])) return;
      const not = remote ? [`--remotes=${remote}`] : ["--remotes"];
      scanLog(terms, top, [src, "--not", ...not], hits);
    },
  };
}

function ghTarget(cmd, cwd) {
  const r = /(?:\s-R|\s--repo)(?:=|\s+)["']?([^\s"'/]+\/[^\s"']+)/.exec(cmd);
  if (r) return r[1].replace(/\.git$/, "");
  const top = repoTop(cwd);
  if (!top) return null;
  const rs = remotes(top);
  const remote = rs.includes("origin") ? "origin" : rs[0];
  return remote ? ownerRepoOf(remoteUrl(top, remote)) : null;
}

// gh のコマンドで渡されたファイル (--body-file・-F・--input・gist の引数) を照らす
function scanFileTokens(terms, cmd, cwd, hits) {
  const seen = new Set();
  for (const raw of tokenize(cmd)) {
    for (const cand of [raw, raw.replace(/^[^=]*=@?/, ""), raw.replace(/^@/, "")]) {
      if (!cand || cand.startsWith("-") || seen.has(cand)) continue;
      const p = path.resolve(cwd, toNativePath(cand));
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      seen.add(cand);
      const txt = readTextFile(p);
      if (txt != null) scanLines(terms, txt, `ファイル ${cand}`, hits);
    }
  }
}

function ghTextChecks(cmd, cwd, orgs) {
  const target = ghTarget(cmd, cwd);
  if (!needsCheck(target, orgs)) return null;
  return {
    target,
    collect(terms, hits) {
      scanText(terms, cmd, "コマンドの文 (タイトル・本文など)", hits);
      scanFileTokens(terms, cmd, cwd, hits);
    },
  };
}

function ghApiChecks(cmd, cwd, orgs) {
  if (!RE_GH_API_WRITE.test(segmentAfter(cmd, RE_GH_API) + " ")) return null;
  const m = /\brepos\/([^/\s"']+)\/([^/\s"'?]+)/.exec(cmd);
  const target = m ? `${m[1]}/${m[2]}` : null;
  if (!needsCheck(target, orgs)) return null;
  return {
    target,
    collect(terms, hits) {
      scanText(terms, cmd, "コマンドの文 (gh api に渡す値)", hits);
      scanFileTokens(terms, cmd, cwd, hits);
    },
  };
}

function gistChecks(cmd, cwd) {
  const seg = segmentAfter(cmd, RE_GIST);
  if (!/(?:^|\s)(?:--public|-p)(?=\s|$)/.test(seg)) return null;
  return {
    target: null,
    allowKey: "gist/public",
    collect(terms, hits) {
      scanText(terms, cmd, "コマンドの文 (gist)", hits);
      scanFileTokens(terms, seg, cwd, hits);
    },
  };
}

function historyCollector(cmd, top) {
  return (terms, hits) => {
    scanText(terms, cmd, "コマンドの文", hits);
    if (!top || !tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"])) return;
    scanLog(terms, top, ["--branches", "--tags", "HEAD"], hits);
  };
}

function repoCreatePublicChecks(cmd, cwd, orgs) {
  const toks = tokenize(segmentAfter(cmd, /\bgh\s+repo\s+create\b/));
  const name = toks.find((t) => !t.startsWith("-"));
  const target = name && name.includes("/") ? name : null;
  if (target && orgs.has(lower(target.split("/")[0]))) return null;
  const srcIdx = toks.findIndex((t) => t === "--source" || t.startsWith("--source=") || t === "-s");
  let top = null;
  if (srcIdx >= 0) {
    const v = toks[srcIdx].startsWith("--source=") ? toks[srcIdx].slice(9) : toks[srcIdx + 1];
    if (v) top = repoTop(path.resolve(cwd, toNativePath(v)));
  }
  return { target, collect: historyCollector(cmd, top) };
}

function repoEditPublicChecks(cmd, cwd, orgs) {
  const toks = tokenize(segmentAfter(cmd, /\bgh\s+repo\s+edit\b/));
  const arg = toks.find((t, i) => !t.startsWith("-") && !/^--visibility$/.test(toks[i - 1] || "") && t.includes("/"));
  const top = repoTop(cwd);
  const own = top ? ghTarget("", cwd) : null;
  const target = arg || own;
  if (target && orgs.has(lower(target.split("/")[0]))) return null;
  const sameRepo = !arg || (own && lower(own) === lower(arg));
  return { target, collect: historyCollector(cmd, sameRepo ? top : null) };
}

function detectChecks(cmd, cwd, orgs) {
  const checks = [];
  const add = (c) => { if (c) checks.push(c); };
  if (RE_COMMIT.test(cmd)) add(commitChecks(cmd, cwd, orgs));
  if (RE_PUSH.test(cmd)) add(pushChecks(cmd, cwd, orgs));
  if (RE_GH_TEXT.test(cmd)) add(ghTextChecks(cmd, cwd, orgs));
  if (RE_GH_API.test(cmd)) add(ghApiChecks(cmd, cwd, orgs));
  if (RE_GIST.test(cmd)) add(gistChecks(cmd, cwd));
  if (RE_REPO_CREATE_PUBLIC.test(cmd)) add(repoCreatePublicChecks(cmd, cwd, orgs));
  if (RE_REPO_EDIT_PUBLIC.test(cmd)) add(repoEditPublicChecks(cmd, cwd, orgs));
  return checks;
}

function isOutgoing(cmd) {
  return [RE_COMMIT, RE_PUSH, RE_GH_TEXT, RE_GH_API, RE_GIST, RE_REPO_CREATE_PUBLIC, RE_REPO_EDIT_PUBLIC].some((re) => re.test(cmd));
}

// ---------- フック ----------

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
}

function maybeRefreshInBackground() {
  try {
    const auto = path.join(CONFIG, "auto.txt");
    const st = fs.statSync(auto);
    if (Date.now() - st.mtimeMs < AUTO_STALE_MS) return;
    const lock = path.join(CONFIG, "refresh.lock");
    try { if (Date.now() - fs.statSync(lock).mtimeMs < VIS_TTL_MS) return; } catch {}
    fs.writeFileSync(lock, String(Date.now()));
    const child = spawn(process.execPath, [SCRIPT, "refresh"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {}
}

function formatHits(hits) {
  const uniq = [];
  const seen = new Set();
  for (const h of hits) {
    const k = `${lower(h.match)}\0${h.where}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(h);
  }
  const lines = uniq.slice(0, MAX_HITS_SHOWN).map((h) => `- 「${h.match}」: ${h.where}`);
  if (uniq.length > MAX_HITS_SHOWN) lines.push(`- ほか ${uniq.length - MAX_HITS_SHOWN} 件`);
  return lines.join("\n");
}

function hook(input) {
  const ti = input.tool_input || {};
  const cmd = Array.isArray(ti.command) ? ti.command.join(" ") : String(ti.command || ti.cmd || "");
  if (!cmd || !isOutgoing(cmd)) return;
  const cwd = resolveCwd(cmd, input.cwd);
  const orgs = loadOrgs();
  const checks = detectChecks(cmd, cwd, orgs);
  if (!checks.length) return;

  const terms = loadTerms();
  if (!terms) {
    deny("[public-guard] この PC には、外に出さない語の一覧がありません。公開リポジトリ (または公開かどうか分からないリポジトリ) への操作なので止めました。" +
      "ユーザーに伝え、`/public-guard:public-guard setup` で一覧を作ってもらってください。");
    return;
  }
  maybeRefreshInBackground();

  const all = [];
  for (const c of checks) {
    const hits = [];
    c.collect(terms, hits);
    const allow = allowSet(c.allowKey || c.target);
    const kept = hits.filter((h) => h.term === CANARY || (!allow.has(lower(h.match)) && !allow.has(lower(h.term))));
    for (const h of kept) all.push({ ...h, target: c.target });
  }
  if (!all.length) return;
  if (all.every((h) => h.term === CANARY)) {
    deny("[public-guard] 試し語を見つけたので止めました。ガードは効いています (doctor の確認なら、これで合格です)。");
    return;
  }
  const real = all.filter((h) => h.term !== CANARY);
  const targets = [...new Set(real.map((h) => h.target || "公開かどうか分からない送り先"))].join(", ");
  deny(
    `[public-guard] 公開リポジトリ (${targets}) に出る文に、外に出さない語が入っています。操作を止めました。\n` +
    `${formatHits(real)}\n` +
    "直し方: 組織や顧客の名前、リポジトリ名、社内の名前、案件の番号、業務の内容を書かず、事例は一般化して書き直してください (例:「ある組織のリポジトリで、PR 本文の検査が…」)。" +
    "コミットに入っているなら、コミットを直してから (commit --amend・rebase) やり直してください。" +
    "どうしても出す必要があると考えるなら、操作する前にユーザーに確かめてください。"
  );
}

// ---------- refresh ----------

function refresh() {
  const orgsOut = gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"], { timeout: 30000 });
  if (orgsOut == null) {
    console.error("public-guard refresh: gh で所属組織を取れませんでした (gh auth status を確かめてください)。前の一覧を使い続けます。");
    return 1;
  }
  const orgs = orgsOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const names = [];
  for (const org of orgs) {
    const out = gh(["repo", "list", org, "--limit", "5000", "--json", "name", "--jq", ".[].name"], { timeout: 60000 });
    if (out == null) {
      console.error(`public-guard refresh: ${org} のリポジトリ一覧を取れませんでした。前の一覧を使い続けます。`);
      return 1;
    }
    names.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }
  fs.mkdirSync(CONFIG, { recursive: true });
  fs.writeFileSync(path.join(CONFIG, "orgs.txt"), orgs.join("\n") + "\n");
  const auto = [...new Set([...orgs, ...names])].sort();
  fs.writeFileSync(path.join(CONFIG, "auto.txt"),
    `# public-guard refresh が作る一覧 (所属組織の名前とそのリポジトリ名)。手で書き換えない。外す語は exclude.txt に書く。\n# ${new Date().toISOString()}\n` +
    auto.join("\n") + "\n");
  // 6 文字以下の名前は誤検知が多いので、初めから除外リストに入れる (持ち主が消せば照らすようになる)
  const exFile = path.join(CONFIG, "exclude.txt");
  const ex = readList(exFile);
  const exSet = new Set((ex || []).map(lower));
  const shortOnes = auto.filter((n) => n.length <= 6 && !exSet.has(lower(n)) && !orgs.map(lower).includes(lower(n)));
  if (ex == null) fs.writeFileSync(exFile, "# 自動の一覧 (auto.txt) から外す語。1 行に 1 つ。\n");
  if (shortOnes.length) fs.appendFileSync(exFile, shortOnes.join("\n") + "\n");
  try { fs.rmSync(path.join(CONFIG, "refresh.lock"), { force: true }); } catch {}
  console.log(`public-guard refresh: 組織 ${orgs.length} 件、語 ${auto.length} 件 (除外に足した短い名前 ${shortOnes.length} 件)。`);
  return 0;
}

// ---------- audit ----------

function auditRepoDir(dir, terms, label, allow, lines) {
  const top = repoTop(dir) || dir;
  let count = 0;
  const push = (kind, where, match) => {
    if (allow.has(lower(match))) return;
    count++;
    lines.push(`  [${kind}] ${where} 「${match}」`);
  };
  if (tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"])) {
    // HEAD のファイル: git grep で候補の行を絞り、同じ照らし方で確かめる
    const cand = new Map();
    const addOut = (out) => {
      for (const l of (out || "").split(/\r?\n/)) {
        const m = /^HEAD:(.+?):(\d+):(.*)$/.exec(l);
        if (m) cand.set(`${m[1]}:${m[2]}`, m[3]);
      }
    };
    const plain = terms.filter((t) => !t.label.startsWith("re:")).map((t) => t.label);
    if (plain.length) {
      const pf = path.join(os.tmpdir(), `public-guard-terms-${process.pid}.txt`);
      fs.writeFileSync(pf, plain.join("\n") + "\n");
      try { addOut(tryGit(top, ["grep", "-I", "-n", "-i", "--no-color", "-F", "-f", pf, "HEAD"])); } finally { fs.rmSync(pf, { force: true }); }
    }
    for (const t of terms.filter((t) => t.label.startsWith("re:"))) {
      addOut(tryGit(top, ["grep", "-I", "-n", "-i", "--no-color", "-P", "-e", t.label.slice(3), "HEAD"]));
    }
    for (const [where, text] of cand) {
      const hits = [];
      scanText(terms, text, where, hits);
      for (const h of hits) push("ファイル", where, h.match);
    }
    // 全コミットのメッセージ
    const msgs = git(top, ["log", "--branches", "--tags", "HEAD", `--format=${LOG_SEP}%h${MSG_END}%B`]);
    for (const chunk of msgs.split(LOG_SEP)) {
      if (!chunk.trim()) continue;
      const [sha, body] = chunk.split(MSG_END);
      const hits = [];
      scanText(terms, body || "", sha, hits);
      for (const h of hits) push("コミット", sha, h.match);
    }
  }
  return count;
}

function auditBodies(ownerRepo, terms, allow, lines) {
  let count = 0;
  for (const kind of ["pr", "issue"]) {
    const out = gh([kind, "list", "-R", ownerRepo, "--state", "all", "--limit", "2000", "--json", "number,title,body"], { timeout: 60000 });
    if (out == null) { lines.push(`  (${kind} の本文を取れませんでした)`); continue; }
    for (const it of JSON.parse(out)) {
      const hits = [];
      scanText(terms, `${it.title}\n${it.body || ""}`, "", hits);
      for (const h of hits) {
        if (allow.has(lower(h.match))) continue;
        count++;
        lines.push(`  [${kind === "pr" ? "PR" : "issue"} #${it.number} のタイトル・本文] 「${h.match}」`);
      }
    }
  }
  return count;
}

function audit(argv) {
  const terms = loadTerms();
  if (!terms) {
    console.error("public-guard audit: 外に出さない語の一覧がありません。/public-guard:public-guard setup で作ってください。");
    return 1;
  }
  const dirIdx = argv.indexOf("--repo-dir");
  const lines = [];
  let total = 0;
  if (dirIdx >= 0) {
    const dir = path.resolve(argv[dirIdx + 1] || ".");
    lines.push(`== ${dir} ==`);
    const n = auditRepoDir(dir, terms, dir, new Set(), lines);
    if (!n) lines.push("  ヒットなし");
    total += n;
  } else {
    const auto = path.join(CONFIG, "auto.txt");
    try { if (Date.now() - fs.statSync(auto).mtimeMs > AUTO_STALE_MS) refresh(); } catch { refresh(); }
    const repoIdx = argv.indexOf("--repo");
    let repos;
    if (repoIdx >= 0) repos = [argv[repoIdx + 1]];
    else {
      const me = (gh(["api", "user", "--jq", ".login"]) || "").trim();
      const out = me && gh(["repo", "list", me, "--visibility", "public", "--limit", "1000", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"], { timeout: 60000 });
      if (!out) { console.error("public-guard audit: gh で公開リポジトリを列挙できませんでした。"); return 1; }
      repos = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    const mirrors = path.join(CONFIG, "mirrors");
    fs.mkdirSync(mirrors, { recursive: true });
    for (const r of repos) {
      lines.push(`== ${r} ==`);
      const dir = path.join(mirrors, r.replace("/", "__") + ".git");
      const ok = fs.existsSync(dir)
        ? spawnSync("git", ["-C", dir, "fetch", "--prune", "--quiet", "origin"], { stdio: "ignore" }).status === 0
        : spawnSync("git", ["clone", "--mirror", "--quiet", `https://github.com/${r}.git`, dir], { stdio: "ignore" }).status === 0;
      const allow = allowSet(r);
      let n = 0;
      if (ok) n += auditRepoDir(dir, terms, r, allow, lines);
      else lines.push("  (clone できませんでした)");
      n += auditBodies(r, terms, allow, lines);
      if (!n) lines.push("  ヒットなし");
      total += n;
    }
  }
  lines.push(`合計 ${total} 件 (報告だけ。直すかどうかは持ち主が決める。後始末は /public-guard:public-guard cleanup)`);
  console.log(lines.join("\n"));
  return 0;
}

// ---------- init ----------

const DENY_TEMPLATE = `# public-guard の手書きの一覧 (外に出さない語)。1 行に 1 つ。正規表現は先頭に re: を付ける。# で始まる行はコメント。
# 英数字の語は語の区切りで、日本語などを含む語は部分一致で、大文字・小文字を区別せずに照らす。
# この一覧は公開しない (どのリポジトリにも入れない)。
`;
const EXCLUDE_TEMPLATE = "# 自動の一覧 (auto.txt) から外す語。1 行に 1 つ。\n";

function init() {
  const changes = [];
  fs.mkdirSync(path.join(CONFIG, "allow"), { recursive: true });
  for (const [name, body] of [["deny.txt", DENY_TEMPLATE], ["exclude.txt", EXCLUDE_TEMPLATE]]) {
    const f = path.join(CONFIG, name);
    if (fs.existsSync(f)) continue;
    fs.writeFileSync(f, body);
    changes.push(`作った: ${f}`);
  }
  console.log(changes.length ? changes.join("\n") : `public-guard init: 変更なし (${CONFIG} はもうあります)`);
  return 0;
}

// ---------- codex-install ----------

function registerHook(file, matcher, command, changes) {
  let obj = {};
  const exists = fs.existsSync(file);
  if (exists) {
    try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      changes.push(`読めないので触らない: ${file}`);
      return;
    }
  }
  obj.hooks ??= {};
  obj.hooks.PreToolUse ??= [];
  const groups = obj.hooks.PreToolUse;
  const existing = groups.flatMap((g) => (g.hooks || []).map((h) => ({ g, h }))).filter(({ h }) => String(h.command || "").includes("public-guard.mjs"));
  if (existing.length === 1 && existing[0].h.command === command && existing[0].g.matcher === matcher) return;
  for (const { g, h } of existing) g.hooks = g.hooks.filter((x) => x !== h);
  let group = groups.find((g) => g.matcher === matcher);
  if (!group) { group = { matcher, hooks: [] }; groups.push(group); }
  group.hooks.push({ type: "command", command, timeout: 60 });
  obj.hooks.PreToolUse = groups.filter((g) => (g.hooks || []).length);
  if (exists) fs.copyFileSync(file, `${file}.bak-public-guard-${new Date().toISOString().replace(/[:.]/g, "")}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  changes.push(`フックを登録: ${file}`);
}

const CODEX_DIR = path.join(HOME, ".codex");
const CODEX_HOOKS = path.join(CODEX_DIR, "hooks.json");
const BIN = path.join(CONFIG, "bin", "public-guard.mjs");
const slash = (p) => p.replace(/\\/g, "/");

function sameFile(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function codexInstall() {
  if (!fs.existsSync(CODEX_DIR)) {
    console.log(`public-guard codex-install: Codex が見当たりません (${CODEX_DIR} がありません)。何もしませんでした。`);
    return 0;
  }
  const changes = [];
  // プラグインの置き場所は版ごとに変わるので、決まった場所に写してそこを指す
  if (path.resolve(SCRIPT) !== path.resolve(BIN) && !sameFile(SCRIPT, BIN)) {
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    fs.copyFileSync(SCRIPT, BIN);
    changes.push(`写した: ${BIN}`);
  }
  registerHook(CODEX_HOOKS, "Bash", `node "${slash(BIN)}"`, changes);
  console.log(changes.length ? changes.join("\n") : "public-guard codex-install: 変更なし (すでに入っています)");
  return 0;
}

// ---------- doctor・selftest ----------

function hookCommandsIn(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    return (obj.hooks?.PreToolUse || []).flatMap((g) => (g.hooks || []).map((h) => String(h.command || ""))).filter((c) => c.includes("public-guard.mjs"));
  } catch { return []; }
}

function doctor() {
  const out = [];
  const ok = (s) => out.push(`OK      ${s}`);
  const ng = (s) => out.push(`要対応  ${s}`);
  const info = (s) => out.push(`参考    ${s}`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) ok(`node ${process.versions.node}`);
  else ng(`node ${process.versions.node} は古い (${MIN_NODE_MAJOR} 以上が要る)。node が動かないとフックは何も言わずに通る`);

  const deny = readList(path.join(CONFIG, "deny.txt"));
  const auto = readList(path.join(CONFIG, "auto.txt"));
  const exclude = readList(path.join(CONFIG, "exclude.txt")) || [];
  const orgs = readList(path.join(CONFIG, "orgs.txt")) || [];
  if (!deny?.length && !auto?.length) ng(`一覧に語がありません (${CONFIG})。setup で作る。このままでは公開リポジトリへの操作はすべて止まる`);
  else ok(`一覧: 手書き ${deny?.length || 0} 語、自動 ${auto?.length || 0} 語 (除外 ${exclude.length} 語、所属組織 ${orgs.length} 件)`);
  try {
    const age = Date.now() - fs.statSync(path.join(CONFIG, "auto.txt")).mtimeMs;
    const days = Math.floor(age / 86400000);
    if (age > AUTO_STALE_MS) info(`自動の一覧は ${days} 日前のもの。次の検査のときに裏で作り直す`);
    else ok(`自動の一覧は ${days} 日前に作った`);
  } catch { info("自動の一覧はありません (組織に入っていなければ要らない)"); }
  let allowFiles = [];
  try { allowFiles = fs.readdirSync(path.join(CONFIG, "allow")).filter((f) => f.endsWith(".txt")); } catch {}
  if (allowFiles.length) info(`許可リスト: ${allowFiles.length} 件 (${allowFiles.join(", ")})`);

  if (spawnSync(GH, ["auth", "status"], { encoding: "utf8", timeout: 15000, windowsHide: true }).status === 0) ok("gh は認証済み (公開の判定と自動の一覧に使う)");
  else ng("gh が無いか、認証されていない。公開かどうか分からないので、すべての送り先を照らす。自動の一覧も作れない");

  const claudeDup = hookCommandsIn(path.join(HOME, ".claude", "settings.json"));
  if (claudeDup.length) ng(`Claude Code の設定 (~/.claude/settings.json) に手で登録した public-guard が ${claudeDup.length} 件ある。プラグインと二重に動くので外す: ${claudeDup.join(" / ")}`);

  if (fs.existsSync(CODEX_DIR)) {
    const cmds = hookCommandsIn(CODEX_HOOKS);
    if (!cmds.length) ng("Codex にフックが登録されていない。codex-install を流す");
    else if (!cmds.some((c) => c.includes(slash(BIN)) || c.includes(BIN))) ng(`Codex のフックが決まった場所 (${BIN}) を指していない: ${cmds.join(" / ")}。codex-install を流す`);
    else if (!sameFile(SCRIPT, BIN)) ng("Codex 用の写しが、このスクリプトと違う版になっている。codex-install を流し直す");
    else ok("Codex のフックは登録済みで、写しも同じ版");
  } else info("Codex は見当たらない");

  out.push("", "フックが本物の経路で効くかは、selftest が出すコマンドを Agent の Bash で流して確かめる。");
  console.log(out.join("\n"));
  return 0;
}

const SELFTEST_REPO = "public-guard-selftest/selftest";

function selftest() {
  for (const e of fs.readdirSync(os.tmpdir())) {
    if (!e.startsWith("public-guard-selftest-")) continue;
    try { fs.rmSync(path.join(os.tmpdir(), e), { recursive: true, force: true }); } catch {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-guard-selftest-"));
  const run = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.name", "public-guard-selftest"]);
  run(["config", "user.email", "selftest@example.invalid"]);
  run(["remote", "add", "origin", `https://github.com/${SELFTEST_REPO}.git`]);
  fs.writeFileSync(path.join(dir, "msg.txt"), `selftest ${CANARY}\n`);
  // 架空のリモートを公開として扱い、gh に問い合わせずに済ませる
  const cache = readVisCache();
  cache[lower(SELFTEST_REPO)] = { visibility: "PUBLIC", at: Date.now() };
  writeVisCache(cache);
  const d = slash(dir);
  console.log([
    "次のコマンドを Agent の Bash でそのまま流す (一時のリポジトリの中だけで動き、外には何も出ない)。",
    "",
    `git -C "${d}" commit --allow-empty -F "${d}/msg.txt"`,
    "",
    "- 「試し語を見つけたので止めました」で止まれば合格。",
    "- 「一覧がありません」で止まれば、フックは効いているが一覧がまだ無い (setup を)。",
    "- 止まらずにコミットできたら、フックが効いていない (プラグインが有効か、node が動くかを確かめる)。",
  ].join("\n"));
  return 0;
}

// ---------- 入口 ----------

const [sub, ...rest] = process.argv.slice(2);
const COMMANDS = { init, refresh, audit, doctor, selftest, "codex-install": codexInstall };
if (sub && Object.hasOwn(COMMANDS, sub)) process.exit(COMMANDS[sub](rest));
else if (sub) {
  console.error(`public-guard: 知らない入口です: ${sub} (使えるもの: ${Object.keys(COMMANDS).join(", ")})`);
  process.exit(2);
} else {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  try {
    hook(JSON.parse(raw));
  } catch (e) {
    // スクリプトの不具合では作業を止めない (fail-open)。ログには残す
    log(`error: ${e?.stack || e}`);
  }
  process.exit(0);
}
