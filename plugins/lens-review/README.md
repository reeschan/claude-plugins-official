# lens-review

変更を観点 (lens) ごとに読み、裏を取れた指摘だけを日本語で報告するコードレビューのプラグインです。
Anthropic の [`code-review`](../code-review) プラグインの骨格 (候補を出す → 1 件ずつ検証する → 確かめられたものだけ出す) を元に、
CodeRabbit が実際に拾っていた観点 (想定外の入力、失敗の握りつぶし、書き込み順、文書と実装の食い違い など) を足しています。

## Install

```
/plugin marketplace add reeschan/claude-plugins-official
/plugin install lens-review@reeschan-plugins
```

CLI では次のとおりです。入れた直後は `/reload-plugins` か再起動が要ります。

```bash
claude plugin marketplace add reeschan/claude-plugins-official
claude plugin install lens-review@reeschan-plugins --scope user
```

marketplace の名前は `reeschan-plugins` です (公式の `claude-plugins-official` と区別するため)。載っているのは `lens-review` と `public-guard` です。

## 使い方

| 例 | 対象 |
|---|---|
| `/lens-review:lens-review` | 既定ブランチとの merge-base と、作業ツリー (未コミット・未追跡を含む) |
| `/lens-review:lens-review 123` | PR #123 |
| `/lens-review:lens-review main..feature -- src/` | 2 点の間を `src/` に絞る |
| `/lens-review:lens-review 123 --comment` | PR #123 をレビューし、インラインコメントとまとめのコメントで投稿する。同じ PR に何度呼んでも重ねず、前の投稿を書き換える |
| `/lens-review:lens-review 123 --comment --min-severity major` | 投稿を major 以上に絞る (端末への出力は全部) |
| `/lens-review:lens-review 123 --comment --min-severity major --post-rule-violations` | 同じく major 以上。ただし `CLAUDE.md`・`AGENTS.md`・`--rules` の決まりに反する指摘は、軽くても投稿する |

- `--rules <path>`: 追加の規約 (ファイルかフォルダ、複数可)。リポジトリの `CLAUDE.md`・`AGENTS.md` は自動で読みます。
- `--spec <path>`: 仕様。仕様との食い違いも見ます。
- `--min-severity <critical|major|minor>`: PR に投稿する指摘の重大度の下限。既定は `minor` (全部)。`--comment` のときだけ効き、端末への出力は変えません。
- `--post-rule-violations`: 観点「規約と仕様」の指摘のうち、リポジトリの `CLAUDE.md`・`AGENTS.md` か `--rules` のファイルの決まりに反するものを、`--min-severity` より軽くても投稿します。仕様・ADR との食い違いは下限に従います。`--comment` のときだけ効きます。
- `--inline`: サブエージェントを使わず、1 人で順に回します (費用を抑えたいとき)。
- `--all`: 件数の上限 (10 件) を外します。
- 依頼文に `Base:`・`Target:`・`Spec:`・`Rules:` の行を書いても同じ意味になります (引数を渡せない呼び出し元のため)。

Agent ツールが使えないところ (サブエージェントの中など) では、自動で順次に切り替わります。

## 0.3.0 の変更

- `--min-severity`・`--post-rule-violations` を足した。投稿する指摘を重大度で絞れる。
- `--comment` を「書き換え」にした。0.2.0 は、まとめのコメントがもうあると投稿をやめていた。0.3.0 は、同じ PR に何度呼ばれても、インラインコメントは (印が同じものを) 重ねず、まとめのコメント (1 行目が `## lens-review`) は 1 つのまま中身を新しくする。投稿者 (`gh api user`、取れなければ `github-actions[bot]`) が書いたものだけを書き換え対象にする。
- bot から呼ばれる形に合わせた。`/lens-review:lens-review <PR 番号> --comment --min-severity <…>[ --post-rule-violations][ --rules <パス>]...[ --spec <パス>]` を受ける。bot の既定の下限は `major`、このプラグインの既定は `minor`。

## 観点

| 観点 | 当てる条件 | 主に見るもの |
|---|---|---|
| 規約と仕様 | いつも | CLAUDE.md・追加の規約・仕様・ADR との食い違い |
| ロジック | コードの変更 | 確実なバグ、境界、一致条件、集計・単位・キー |
| 入力と失敗 | コードの変更 | 想定外の入力 1 件で落ちる、失敗を成功に見せる、範囲の外に届く入力 |
| 状態と外部 | コードの変更 | 途中の失敗で残る状態、並行実行、外部呼び出しの上限、OS・文字コード |
| 文書と手順 | `.md`・`.d2`・設定ファイル | 記述と実装の食い違い、動かないコマンド例、手順の分岐の抜け |
| テスト | テストのファイル | 実装を壊しても通るテスト、追跡されていない fixture |
| 合否と承認 | 確認・承認・合否・完了を扱うコードかスキル本文 | 失敗や結果の無いまま進む、古い結果を今回の根拠にする、承認を使う時点のずれ |
| 文字列による判定 | 文字列の照合かテキストの解析を足すコード | 語が出たことを実行・合格の根拠にする、手書きの Markdown の解析の誤り |

## 出力

```
## レビュー結果: 指摘 2 件 (critical 0 / major 1 / minor 1)、棄却 3 件
対象: a1b2c3d と作業ツリー、12 ファイル。観点: 規約と仕様・ロジック・入力と失敗・文書と手順

- [major] src/flow.py:120 — `meta.json` が dict であることを確かめてから `.get()` を呼ぶ — `meta.json` に `null` を書いて実行すると AttributeError
- [minor] docs/engine.md:88 — 例のコマンドに必須の `--question` を足す — `python record.py slice x` が exit 2

### 1. [major・すぐ直せる] `meta.json` が dict であることを確かめてから `.get()` を呼ぶ
...
```

一覧の 1 行 (`- [重大度] file:line — 見出し — 裏取り`) は、[Atelier](https://github.com/reeschan/atelier) の最終レビューの結果ファイルと同じ書式です。

## 由来

- Anthropic の [`plugins/code-review`](../code-review) (Apache-2.0) を元にした派生です。`LICENSE` は元と同じです。
- 元から引き継いだもの: 手順の骨格、誤検知の一覧、1 つの問題に 1 コメント、suggestion の条件、完全な SHA のリンク。
- 変えたもの:
  - 「入力に依存する問題は出さない」を「再現できる入力を 1 つ示せるなら出す」に変えた。
  - 同じ役の担当を 2 人ずつ置く形をやめ、観点の違う担当を 1 人ずつ置く。担当はファイルの種別 (2 つは diff の中身) で選ぶ。
  - 子を起こすのは 1 段だけにし、Agent ツールが無ければ順次で回す。子のモデルは指定しない。
  - PR だけでなく手元の diff も対象にする。出力を日本語にする。
- [`plugins/pr-review-toolkit`](../pr-review-toolkit) の `silent-failure-hunter`・`pr-test-analyzer`・`comment-analyzer` の見方を、観点のチェックリストに取り込んだ (エージェント定義そのものは使わない)。
- 設計書: [`docs/lens-review/spec.md`](../../docs/lens-review/spec.md)

## upstream との同期

- このリポジトリの `main` は upstream (`anthropics/claude-plugins-official`) の写しで、自分のコミットを置きません。変更は既定ブランチ `reeschan` にあります。
- 最後に見比べた upstream のコミット: `e37d307b` (2026-11-12)
- 同期の手順:

  ```bash
  git fetch upstream
  git checkout main && git merge --ff-only upstream/main && git push origin main
  git log e37d307b..upstream/main -- plugins/code-review plugins/pr-review-toolkit
  git checkout reeschan && git merge main
  # 衝突したら、自分の側を残してマージを終える
  git checkout --ours .claude-plugin/marketplace.json
  git add .claude-plugin/marketplace.json
  git merge --continue
  ```

  `plugins/code-review` か `pr-review-toolkit` の手順・誤検知の一覧に変更があれば、`lens-review` に手で写し、上のコミットを更新します。
