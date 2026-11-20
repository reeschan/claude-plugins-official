// public-guard のテスト。node --test で流す。
// 一時の git リポジトリと一時の設定フォルダ (PUBLIC_GUARD_HOME) を使い、公開の判定はキャッシュで決める。
// ネットワークには出ない (PUBLIC_GUARD_GH を存在しないコマンドにして、gh の呼び出しを必ず失敗させる)。
// 語はすべて架空のもの。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "scripts", "public-guard.mjs");
const OWNER = "someone";
const ORG = "acme-org";
const WORD = "zyxproj-billing";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeConfig({ deny = [WORD, "re:\\bZQ-\\d{3}\\b", "架空商事"], auto = [ORG, "acme-portal-server"], orgs = [ORG], visibility = {}, allow = {} } = {}) {
  const dir = tmp("pg-config-");
  if (deny) fs.writeFileSync(path.join(dir, "deny.txt"), ["# 手書きの一覧", ...deny].join("\n") + "\n");
  if (auto) fs.writeFileSync(path.join(dir, "auto.txt"), ["# 自動", ...auto].join("\n") + "\n");
  if (orgs) fs.writeFileSync(path.join(dir, "orgs.txt"), orgs.join("\n") + "\n");
  const cache = {};
  for (const [repo, vis] of Object.entries(visibility)) cache[repo.toLowerCase()] = { visibility: vis, at: Date.now() };
  fs.writeFileSync(path.join(dir, "visibility-cache.json"), JSON.stringify(cache));
  for (const [repo, words] of Object.entries(allow)) {
    fs.mkdirSync(path.join(dir, "allow"), { recursive: true });
    fs.writeFileSync(path.join(dir, "allow", repo.replace("/", "__") + ".txt"), words.join("\n") + "\n");
  }
  return dir;
}

function makeRepo({ owner = OWNER, name = "pub" } = {}) {
  const dir = tmp("pg-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", `https://github.com/${owner}/${name}.git`);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function commitFile(repo, file, content, msg = "change") {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

function runHook(command, { cwd, config, toolName = "Bash", raw } = {}) {
  const input = raw ?? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { command }, cwd });
  const r = spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_GUARD_HOME: config, PUBLIC_GUARD_GH: "pg-no-such-gh-command" },
  });
  assert.equal(r.status, 0, `exit code should be 0, stderr: ${r.stderr}`);
  if (!r.stdout.trim()) return { denied: false, reason: "" };
  const out = JSON.parse(r.stdout);
  const h = out.hookSpecificOutput || {};
  return { denied: h.permissionDecision === "deny", reason: h.permissionDecisionReason || "" };
}

const PUBLIC = { [`${OWNER}/pub`]: "PUBLIC" };

// --- フックの入口 ---

test("関係の無いコマンドは通す", () => {
  const repo = makeRepo();
  const r = runHook(`echo ${WORD}`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, false);
});

test("コミットメッセージに禁止語があれば止め、語と書き直しの指示を返す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "fix the ${WORD} case"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, new RegExp(WORD));
  assert.match(r.reason, /一般化/);
});

test("stage 済みの差分の追加行に禁止語があれば、ファイルと行を返して止める", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "notes.md"), `line one\nsee ${WORD} here\n`);
  git(repo, "add", "notes.md");
  const r = runHook(`git commit -m "add notes"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /notes\.md:2/);
});

test("消した行にだけ禁止語があるコミットは通す", () => {
  const repo = makeRepo();
  commitFile(repo, "notes.md", `keep\n${WORD}\n`);
  fs.writeFileSync(path.join(repo, "notes.md"), "keep\n");
  git(repo, "add", "notes.md");
  // 語を入れたコミットは前からあるもので、ここで調べるのは語を消すコミットだけ
  const r = runHook(`git commit -m "remove it"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, false, r.reason);
});

test("git add を含むコマンドでは、まだ stage されていない新しいファイルも調べる", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "new.txt"), `about ${WORD}\n`);
  const r = runHook(`git add -A && git commit -m "add new"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /new\.txt:1/);
});

test("git commit -a では、stage していない変更も調べる", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), `hello\n${WORD}\n`);
  const r = runHook(`git commit -am "update"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("非公開のリポジトリでは通す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${WORD}"`, { cwd: repo, config: makeConfig({ visibility: { [`${OWNER}/pub`]: "PRIVATE" } }) });
  assert.equal(r.denied, false);
});

test("組織のリポジトリでは通す", () => {
  const repo = makeRepo({ owner: ORG, name: "acme-portal-server" });
  const r = runHook(`git commit -m "${WORD} acme-portal-server"`, { cwd: repo, config: makeConfig() });
  assert.equal(r.denied, false);
});

test("公開かどうか分からないときは公開とみなして調べる", () => {
  const repo = makeRepo({ name: "unknown-vis" });
  const r = runHook(`git commit -m "${WORD}"`, { cwd: repo, config: makeConfig() });
  assert.equal(r.denied, true);
});

test("リモートの無いリポジトリでのコミットは通す (外へ出ないため)", () => {
  const repo = makeRepo();
  git(repo, "remote", "remove", "origin");
  const r = runHook(`git commit -m "${WORD}"`, { cwd: repo, config: makeConfig() });
  assert.equal(r.denied, false);
});

test("cd で移った先のリポジトリを調べる", () => {
  const repo = makeRepo();
  const other = tmp("pg-elsewhere-");
  const r = runHook(`cd "${repo.replace(/\\/g, "/")}" && git commit -m "${WORD}"`, { cwd: other, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("push では、push 先にまだ無いコミットのメッセージと差分を調べる", () => {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", base);
  const sha = commitFile(repo, "a.txt", "plain\n", `mention ${WORD}`);
  const r = runHook(`git push origin main`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, new RegExp(sha.slice(0, 7)));
});

test("push 先に既にあるコミットの語では止めない", () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", `${WORD}\n`, "old");
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD"));
  commitFile(repo, "b.txt", "clean\n", "clean change");
  const r = runHook(`git push`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, false, r.reason);
});

test("新しいブランチの push では、どのリモートにも無いコミットを調べる", () => {
  const repo = makeRepo();
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD"));
  git(repo, "checkout", "-q", "-b", "feat");
  commitFile(repo, "c.txt", `${WORD}\n`, "feat");
  const r = runHook(`git push -u origin feat`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /c\.txt:1/);
});

test("gh pr create の --body に禁止語があれば止める", () => {
  const repo = makeRepo();
  const r = runHook(`gh pr create --title "t" --body "Found in ${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("gh pr create の --body-file の中身も調べる", () => {
  const repo = makeRepo();
  const body = path.join(tmp("pg-body-"), "body.md");
  fs.writeFileSync(body, `## Summary\n\nThe 架空商事 run showed this.\n`);
  const r = runHook(`gh pr create --title "t" --body-file "${body.replace(/\\/g, "/")}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /架空商事/);
});

test("gh pr edit での本文の書き換えも調べる", () => {
  const repo = makeRepo();
  const r = runHook(`gh pr edit 3 --body "ticket ZQ-123 says so"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /ZQ-123/);
});

test("-R で指定した非公開のリポジトリへの gh は通す", () => {
  const repo = makeRepo();
  const r = runHook(`gh issue create -R ${OWNER}/secret --title "${WORD}" --body x`, {
    cwd: repo,
    config: makeConfig({ visibility: { ...PUBLIC, [`${OWNER}/secret`]: "PRIVATE" } }),
  });
  assert.equal(r.denied, false);
});

test("gh api の書き込みを調べる", () => {
  const repo = tmp("pg-norepo-");
  const r = runHook(`gh api -X PATCH repos/${OWNER}/pub/pulls/1 -f body="from ${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("gh api の読み取りは通す", () => {
  const repo = tmp("pg-norepo-");
  const r = runHook(`gh api repos/${OWNER}/pub/pulls/1 --jq .body | grep ${WORD}`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, false);
});

test("許可リストにある語では止めない", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC, allow: { [`${OWNER}/pub`]: [WORD] } }) });
  assert.equal(r.denied, false);
});

test("許可リストは別のリポジトリには効かない", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC, allow: { [`${OWNER}/other`]: [WORD] } }) });
  assert.equal(r.denied, true);
});

test("語の途中の一部分にだけ当たる英数字の語では止めない", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${WORD}ish and x${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, false, r.reason);
});

test("大文字・小文字を区別しない", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${WORD.toUpperCase()}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("自動の一覧 (組織のリポジトリ名) でも止める", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "ported from acme-portal-server"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("除外リストの語は自動の一覧から外す", () => {
  const repo = makeRepo();
  const config = makeConfig({ visibility: PUBLIC });
  fs.writeFileSync(path.join(config, "exclude.txt"), "acme-portal-server\n");
  const r = runHook(`git commit -m "ported from acme-portal-server"`, { cwd: repo, config });
  assert.equal(r.denied, false);
});

test("禁止語の一覧が無ければ、公開リポジトリへの操作を止めて setup を促す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "anything"`, { cwd: repo, config: makeConfig({ deny: null, auto: null, visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /public-guard:public-guard setup/);
});

test("禁止語の一覧が無くても、非公開のリポジトリへの操作は通す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "anything"`, { cwd: repo, config: makeConfig({ deny: null, auto: null, visibility: { [`${OWNER}/pub`]: "PRIVATE" } }) });
  assert.equal(r.denied, false);
});

test("壊れた JSON では通す", () => {
  const r = runHook("", { raw: "{not json", config: makeConfig() });
  assert.equal(r.denied, false);
});

test("禁止語の一覧そのものをコミットしようとすると止める", () => {
  const repo = makeRepo();
  const config = makeConfig({ visibility: PUBLIC });
  fs.copyFileSync(path.join(config, "deny.txt"), path.join(repo, "deny.txt"));
  git(repo, "add", "deny.txt");
  const r = runHook(`git commit -m "add list"`, { cwd: repo, config });
  assert.equal(r.denied, true);
});

test("コマンドに環境変数を付けても検査は飛ばせない", () => {
  const repo = makeRepo();
  const empty = tmp("pg-empty-");
  const r = runHook(`PUBLIC_GUARD_HOME=${empty} git commit -m "${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("PowerShell のコマンドも調べる", () => {
  const repo = makeRepo();
  const r = runHook(`Set-Location "${repo}"; git commit -m "${WORD}"`, { toolName: "PowerShell", cwd: tmp("pg-ps-"), config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
});

test("非公開を公開に変える操作では、全履歴を調べる", () => {
  const repo = makeRepo();
  commitFile(repo, "old.txt", `${WORD}\n`, "old");
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD"));
  const r = runHook(`gh repo edit --visibility public --accept-visibility-change-consequences`, {
    cwd: repo,
    config: makeConfig({ visibility: { [`${OWNER}/pub`]: "PRIVATE" } }),
  });
  assert.equal(r.denied, true);
  assert.match(r.reason, /old\.txt:1/);
});

test("公開の gist の作成を調べる", () => {
  const dir = tmp("pg-gist-");
  const f = path.join(dir, "snip.md");
  fs.writeFileSync(f, `${WORD}\n`);
  const r = runHook(`gh gist create --public "${f.replace(/\\/g, "/")}"`, { cwd: dir, config: makeConfig() });
  assert.equal(r.denied, true);
});

// --- audit の入口 ---

test("audit --repo-dir は HEAD のファイルとコミットメッセージのヒットを報告する", () => {
  const repo = makeRepo();
  commitFile(repo, "docs/spec.md", `intro\nthe ${WORD} case\n`, "plain message");
  commitFile(repo, "x.txt", "x\n", "about ZQ-042");
  const r = spawnSync(process.execPath, [SCRIPT, "audit", "--repo-dir", repo], {
    encoding: "utf8",
    env: { ...process.env, PUBLIC_GUARD_HOME: makeConfig(), PUBLIC_GUARD_GH: "pg-no-such-gh-command" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docs\/spec\.md:2/);
  assert.match(r.stdout, /ZQ-042/);
});

test("audit --repo-dir はヒットが無ければそう報告する", () => {
  const repo = makeRepo();
  const r = spawnSync(process.execPath, [SCRIPT, "audit", "--repo-dir", repo], {
    encoding: "utf8",
    env: { ...process.env, PUBLIC_GUARD_HOME: makeConfig(), PUBLIC_GUARD_GH: "pg-no-such-gh-command" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ヒットなし/);
});

// --- 試し語 ---

// 試し語はソースにそのまま書かない (このリポジトリへのコミットが止まるので組み立てる)
const CANARY = ["public", "guard", "canary", "7f3a"].join("-");

test("試し語は一覧に書かなくても止め、合格の文を返す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${CANARY}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, /試し語/);
});

test("試し語は許可リストに書いても止める", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${CANARY}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC, allow: { [`${OWNER}/pub`]: [CANARY] } }) });
  assert.equal(r.denied, true);
});

test("試し語と本物の語が両方あれば、本物の語を返す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${CANARY} ${WORD}"`, { cwd: repo, config: makeConfig({ visibility: PUBLIC }) });
  assert.equal(r.denied, true);
  assert.match(r.reason, new RegExp(WORD));
  assert.doesNotMatch(r.reason, /試し語/);
});

test("試し語でも、非公開のリポジトリへの操作は通す", () => {
  const repo = makeRepo();
  const r = runHook(`git commit -m "${CANARY}"`, { cwd: repo, config: makeConfig({ visibility: { [`${OWNER}/pub`]: "PRIVATE" } }) });
  assert.equal(r.denied, false);
});

// --- init・selftest・doctor・codex-install の入口 ---

function runSub(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PUBLIC_GUARD_GH: "pg-no-such-gh-command", ...env } });
}

test("init は空の一覧のひな形を作り、2 回目は何も変えない。ひな形だけでは公開リポジトリへの操作を止める", () => {
  const config = path.join(tmp("pg-init-"), "public-guard");
  const r1 = runSub(["init"], { PUBLIC_GUARD_HOME: config });
  assert.equal(r1.status, 0, r1.stderr);
  const deny1 = fs.readFileSync(path.join(config, "deny.txt"), "utf8");
  assert.ok(fs.existsSync(path.join(config, "exclude.txt")));
  fs.appendFileSync(path.join(config, "deny.txt"), "# 持ち主のメモ\n");
  const r2 = runSub(["init"], { PUBLIC_GUARD_HOME: config });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(path.join(config, "deny.txt"), "utf8"), deny1 + "# 持ち主のメモ\n", "既にある一覧は書き換えない");

  const repo = makeRepo();
  fs.writeFileSync(path.join(config, "visibility-cache.json"), JSON.stringify({ [`${OWNER}/pub`]: { visibility: "PUBLIC", at: Date.now() } }));
  const r = runHook(`git commit -m "anything"`, { cwd: repo, config });
  assert.equal(r.denied, true);
  assert.match(r.reason, /setup/);
});

test("selftest が出すコマンドをフックに渡すと、試し語で止まる", () => {
  const config = makeConfig();
  const r = runSub(["selftest"], { PUBLIC_GUARD_HOME: config });
  assert.equal(r.status, 0, r.stderr);
  const cmd = r.stdout.split(/\r?\n/).find((l) => l.startsWith("git -C "));
  assert.ok(cmd, r.stdout);
  assert.doesNotMatch(r.stdout, new RegExp(CANARY), "試し語そのものは画面に出さない");
  const h = runHook(cmd, { cwd: tmp("pg-elsewhere-"), config });
  assert.equal(h.denied, true);
  assert.match(h.reason, /試し語/);
});

test("doctor は一覧が無いことと、Claude Code の設定に残った手作りの登録を知らせる", () => {
  const home = tmp("pg-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node \"/x/public-guard.mjs\"" }] }] } }));
  const r = runSub(["doctor"], { USERPROFILE: home, HOME: home, PUBLIC_GUARD_HOME: path.join(home, "cfg") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /要対応 +一覧に語がありません/);
  assert.match(r.stdout, /二重/);
  assert.match(r.stdout, /Codex は見当たらない/);
});

test("codex-install は 2 回流しても同じ結果になり、決まった場所の写しを 1 つだけ登録する", () => {
  const home = tmp("pg-home-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node other.mjs" }, { type: "command", command: "node \"/old/place/public-guard.mjs\"" }] }] } }, null, 2));
  const config = path.join(home, "cfg");
  const env = { USERPROFILE: home, HOME: home, PUBLIC_GUARD_HOME: config };
  const r1 = runSub(["codex-install"], env);
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  const s1 = fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8");
  const r2 = runSub(["codex-install"], env);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.match(r2.stdout, /変更なし/);
  assert.equal(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"), s1);

  const cmds = JSON.parse(s1).hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  const guard = cmds.filter((c) => c.includes("public-guard.mjs"));
  assert.equal(guard.length, 1, "古い登録は置き換える");
  assert.ok(guard[0].includes(path.join(config, "bin", "public-guard.mjs").replace(/\\/g, "/")));
  assert.ok(cmds.includes("node other.mjs"), "ほかのフックは残す");
  assert.ok(fs.readFileSync(path.join(config, "bin", "public-guard.mjs")).equals(fs.readFileSync(SCRIPT)));

  const d = runSub(["doctor"], env);
  assert.match(d.stdout, /OK +Codex のフックは登録済みで、写しも同じ版/);
});

test("codex-install は Codex が無ければ何もしない", () => {
  const home = tmp("pg-home-");
  const r = runSub(["codex-install"], { USERPROFILE: home, HOME: home, PUBLIC_GUARD_HOME: path.join(home, "cfg") });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, ".codex")));
});

test("知らない入口は終了コード 2 で知らせる", () => {
  const r = runSub(["install"], { PUBLIC_GUARD_HOME: makeConfig() });
  assert.equal(r.status, 2);
});
