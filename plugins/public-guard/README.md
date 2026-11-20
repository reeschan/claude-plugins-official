# public-guard

Agent が公開リポジトリに、外に出したくない語 (所属組織の名前やリポジトリ名、顧客名、社内のツールの名前など) を書こうとしたら、その操作を止めるプラグインです。

仕事のリポジトリで見つけた事例を手がかりに、自分の公開リポジトリを直すとき、Agent はその事例の固有名詞をコミットメッセージや PR 本文にそのまま書きがちです。PR 本文の編集履歴や force-push 前のコミットは GitHub に残るので、一度出たものは完全には消せません。このプラグインは、出る前に止めます。

## Install

```
/plugin marketplace add reeschan/claude-plugins-official
/plugin install public-guard@reeschan-plugins
```

CLI では次のとおりです。入れた直後は `/reload-plugins` か再起動が要ります。

```bash
claude plugin marketplace add reeschan/claude-plugins-official
claude plugin install public-guard@reeschan-plugins --scope user
```

入れたら、一覧を作ります。

```
/public-guard:public-guard setup
```

一覧ができるまでは、公開リポジトリへの操作はすべて止まります (何も言わずに素通りするのを防ぐため)。

## 必要なもの

- **Node.js 20 以上** (`node` が PATH にあること)。node が無いとフックのコマンドが失敗し、Claude Code はそれを「止める」と読まないので、何も言わずに通ってしまいます。`/public-guard:public-guard doctor` で確かめられます。
- **git**
- **gh** (GitHub CLI、認証済み)。公開かどうかの判定と、所属組織の名前の自動の一覧に使います。無いと、すべての送り先を公開とみなして照らします。

## 止める操作

フックは Claude Code の `Bash` と `PowerShell` の道具の呼び出しを見ます。

| 操作 | 照らす文 |
|---|---|
| `git commit` | メッセージ (`-m`・`-F` のファイル)、stage 済みの差分。同じコマンドに `git add` か `-a` があれば、作業ツリーの差分と未追跡のファイルも |
| `git push` | push 先にまだ無いコミットの差分とメッセージ |
| `gh pr` / `gh issue` の create・edit・comment・review・merge・close・reopen、`gh release` の create・edit | コマンドの文と、`--body-file` などで渡したファイル |
| `gh api` の書き込み (`-X POST/PATCH/PUT`、`-f`・`-F`・`--input`) | コマンドの文と渡したファイル |
| `gh gist create --public` | コマンドの文と渡したファイル |
| `gh repo create --public`、`gh repo edit --visibility public` | 全履歴 |

- 差分は追加した行だけを見ます (語を消すための変更は通ります)。
- 対象は公開リポジトリです (持ち主は問いません。他人の OSS への PR も照らします)。所属組織のリポジトリと非公開のリポジトリは照らしません。公開かどうか分からなければ公開とみなします。
- 止めたときは、ヒットした語と場所、「一般化して書き直す」という指示を Agent に返します。語は手元の Agent にだけ返り、GitHub には送りません。
- 検査を飛ばすフラグや環境変数はありません。

## 一覧

一覧は `~/.config/public-guard/` にだけ置きます。どのリポジトリにも入れません (一覧そのものが外に出したくない文脈なので)。一覧のファイルを公開リポジトリにコミットしようとすると、ガード自身が止めます。

| ファイル | 中身 |
|---|---|
| `deny.txt` | 手書きの語。1 行に 1 つ。`re:` で始めると正規表現。`#` で始まる行はコメント |
| `auto.txt` | 所属組織の名前とそのリポジトリ名 (`gh` で自動で作る。7 日ごとに作り直す) |
| `exclude.txt` | 自動の一覧から外す語。6 文字以下の名前は初めから入る |
| `orgs.txt` | 所属組織 (この持ち主のリポジトリは照らさない) |
| `allow/<owner>__<repo>.txt` | そのリポジトリでだけ出してよい語。持ち主が書く |

英数字の語は語の区切りで、日本語などを含む語は部分一致で、大文字・小文字を区別せずに照らします。

別の PC で使うときは、プラグインを入れたうえで、`deny.txt`・`exclude.txt`・`allow/` を自分の手段 (暗号化したストレージなど) で写してください。`auto.txt` はその PC の `gh` で作り直されます。

## スキル

| 呼び方 | すること |
|---|---|
| `/public-guard:public-guard setup` | 一覧を作る。所属組織からの自動の一覧、手書きの候補集め、誤検知の測定、確定、Codex への登録 |
| `/public-guard:public-guard audit` | 自分の公開リポジトリに語が残っていないかを報告する (直さない) |
| `/public-guard:public-guard doctor` | 状態を確かめる。node・一覧・gh・Codex の登録と版・二重の登録。最後に、試し語のコミットで本物のフックが止めるかを確かめる |
| `/public-guard:public-guard cleanup` | 出てしまったときの後始末 (編集履歴の版を消す・履歴を書き換える・GitHub Support に頼む) を案内する |

## Codex

Codex にはプラグインの仕組みが無いので、`setup` の中で `codex-install` を流し、スクリプトを `~/.config/public-guard/bin/public-guard.mjs` に写して `~/.codex/hooks.json` に登録します。プラグインを更新したら、`doctor` が写しの版の違いを知らせるので、流し直してください。

プラグインを使わずに Codex だけで使うときは、このリポジトリを clone して次を流します。

```bash
node plugins/public-guard/scripts/public-guard.mjs init
node plugins/public-guard/scripts/public-guard.mjs codex-install
```

## 止められないもの

- 語では照らせない「業務の内容」。Agent への決まりで補ってください。例えば `CLAUDE.md` や `AGENTS.md` に次のように書きます。

  ```markdown
  ## 公開リポジトリと所属組織の文脈
  - 公開リポジトリのコード・コミットメッセージ・PR・issue には、所属組織のリポジトリ名・案件の番号・ファイルパス・社内の名前・顧客名・業務の内容を書かない。
  - 組織のリポジトリで見つけた事例は一般化して書く (例:「ある組織のリポジトリで、PR 本文の検査が…」)。証拠は手元にだけ置く。
  - 別のセッションに渡す依頼文にも「公開リポジトリ向け。組織の文脈は書かず、一般化して書く」と書く。
  ```

- 人が手で打つ git や gh の操作、スクリプトのファイルの中で呼ばれる git。
- API キーなどの秘密情報。[gitleaks](https://github.com/gitleaks/gitleaks) や GitHub の secret scanning を使ってください。

## テスト

```bash
node --test plugins/public-guard/tests/public-guard.test.mjs
```

一時の git リポジトリと一時の設定フォルダを使い、ネットワークには出ません。語はすべて架空のものです。

## License

Apache-2.0
