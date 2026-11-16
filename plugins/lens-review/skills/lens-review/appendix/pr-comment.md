# 付録: PR への投稿 (`--comment`)

`--comment` が付いているときだけ読む。端末への出力は、投稿するかどうかに関係なく先に出しておく (端末には `--min-severity` も `--post-rule-violations` も効かない)。

投稿は「書き換え」: 同じ PR に何度呼ばれても、インラインコメントは重ねず、まとめのコメントは 1 つのまま中身だけを新しくする。

## 投稿しない条件

次のどれかなら投稿せず、理由を端末に 1 行で出して終わる。

- 対象が PR ではない (手元の diff)。
- `gh` が使えない (コマンドが無い、`gh auth status` が通らない)。閉じているかの確認、投稿済みの印とまとめの検索、head の確認、投稿のどれにも `gh` が要るため。
- PR が閉じている (`gh pr view <n> --json state`)。

まとめのコメントや指摘の印がもうあっても、投稿をやめない (下の流れで書き換える)。

## 引数

- `--min-severity <critical|major|minor>`: 投稿する指摘の重大度の下限。既定は `minor` (全部出す)。`major` なら critical と major、`critical` なら critical だけ。
- `--post-rule-violations`: 観点「規約と仕様」の指摘のうち、リポジトリの `CLAUDE.md`・`AGENTS.md` か `--rules` のファイルの決まりに反するものは、`--min-severity` より軽くても投稿する。仕様・ADR との食い違いは、ほかの指摘と同じく `--min-severity` に従う。

## 流れ

1. 投稿者を決める: `gh api user --jq .login`。取れない (`GITHUB_TOKEN` では `/user` が使えない) ときは `github-actions[bot]`。以降、印とまとめを探すときは、書き手 (`user.login`) がこの投稿者と同じものだけを見る (人が書いた `## lens-review` や印で、指摘が消えたり、まとめが乗っ取られたりしないように)。
2. 出す候補を決める。確認済みの指摘のうち:
   - 重大度が `--min-severity` 以上のもの。
   - `--post-rule-violations` があれば、観点「規約と仕様」の指摘で、リポジトリの `CLAUDE.md`・`AGENTS.md` か `--rules` のファイルの決まりに反するものも (下限より軽くても)。
   - 要確認は出さない。下限より軽くて出さなかった確認済みの指摘は、件数だけを数えておく (まとめに書く)。
3. 既存のインラインコメントを `gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate` で並べる。書き手が 1 の投稿者のものだけを見て、印 `<!-- lens-review: <file>:<行> <見出し> -->` (下の「1 件の本文の順」) が候補と同じ指摘は、候補から除く (前に出して残っている指摘として、まとめの一覧に載せる)。同じ指摘かは、ファイルと見出しで見る: 同じファイルで見出しが同じなら、行が違っても (push で行がずれても) 同じ指摘とみなす。
4. 出す前に、残った新しい指摘の一覧を自分で見直す (どこにも出さない)。同じ問題のコメントが 2 つ無いこと、要確認と下限より軽いもの (規約違反の例外を除く) が入っていないことを確かめる。行が diff に無い指摘 (下の「インラインコメント」) は、ここでレビューから外し、まとめの一覧にリンクで並べる側に移す。
5. 今の head を `gh pr view <n> --json headRefOid --jq .headRefOid` で読み、SKILL.md の `## 流れ` で対象を取ったときに控えた SHA と比べる。違えば (レビューの途中で push があった)、投稿せず、そのことを端末に 1 行で出して終える。同じなら、残った新しい指摘を 1 つのレビューにまとめて付ける。無ければレビューは付けない。
6. まとめのコメントを書き換える。1 行目が `## lens-review` で、書き手が 1 の投稿者の PR のコメントを `gh api repos/<owner>/<repo>/issues/<n>/comments --paginate` で探す。
   - あれば `gh api repos/<owner>/<repo>/issues/comments/<id> --method PATCH --input <一時フォルダ>/summary.json` で書き換える。2 つ以上あれば最初の 1 つを書き換える。
   - 無ければ `gh api repos/<owner>/<repo>/issues/<n>/comments --method POST --input <一時フォルダ>/summary.json` で足す。
   - `summary.json` の形: `{"body": "<まとめの本文>"}`。

投稿の `gh api` (5 のレビュー、6 のまとめ) が失敗したら (422 を含む)、`gh` の出力を理由として端末に出し、失敗として終える (あとの投稿に続けない)。

一時ファイル (`review.json`・`summary.json`) は `/tmp` か `$RUNNER_TEMP/lens-review-claude/` の下に置く (手元では OS の一時フォルダでよい)。

head の SHA (`review.json` の `commit_id` と、まとめの「レビューした head の完全な SHA」) は、SKILL.md の `## 流れ` で対象を取ったときに控えた SHA を使う。投稿のときに読み直した値は使わない (指摘の行番号は控えた head のもの)。

## インラインコメント

- 1 つのレビューにまとめて出す (通知が 1 回で済む)。承認も却下もしない。

  ```bash
  gh api repos/<owner>/<repo>/pulls/<n>/reviews --method POST --input <一時フォルダ>/review.json
  ```

  `review.json` の形: `{"commit_id": "<head の完全な SHA>", "event": "COMMENT", "body": "<本文>", "comments": [{"path": "<file>", "line": <行>, "side": "RIGHT", "body": "<指摘>"}]}`。レビューの本文 (`body`) は「lens-review: 新しい指摘 <n> 件」のような 1 行でよい (一覧はまとめのコメントに書く)。複数行なら `start_line` と `start_side` も付ける。追加・変更された行は `side: "RIGHT"` と変更後の行番号、削除された行は `side: "LEFT"` と基準の版の行番号にする。行が diff に無いと 422 になるので、その指摘はインラインに付けず (出す前の見直しで外す)、まとめの一覧にリンクで並べる。
- 1 件の本文の順: 印の行 `<!-- lens-review: <file>:<行> <見出し> -->` → 「**[重大度・手間] 見出し**」→ 理由 → 直し方 → 裏取り。日本語で書く。印は、やり直したときに投稿済みの指摘を見分けるために使う。
- suggestion (````suggestion` のブロック) は、5 行以内で、それを入れるだけで直り切るときだけ付ける。続きの作業が要るなら文で書く。

## まとめのコメント

本文は次の順 (毎回、全部を新しく書く):

1. 1 行目: `## lens-review`
2. 重大度ごとの件数: `critical <n> / major <n> / minor <n>` (投稿した指摘と、前に出して残っている指摘の合計)。
3. 出さなかった件数: 下限より軽くて出さなかった確認済みの指摘の数 (`--min-severity` が `minor` なら 0 件)。
4. 確認した観点。
5. レビューした head の完全な SHA。
6. 今回出した指摘と、前に出して残っている指摘の一覧。1 件 1 行で `[重大度] file:line — 見出し`。diff の外の行の指摘は、`file:line` とリンクで並べる。

- リンクの形: `https://github.com/<owner>/<repo>/blob/<完全な SHA>/<path>#L<始め>-L<終わり>`。前後 1 行を含める (5〜6 行目なら `#L4-L7`)。`$(git rev-parse HEAD)` のような式は展開されないので、SHA を文字で書く。
- 指摘が無いとき: `## lens-review` と「指摘なし。確認した観点: …」、出さなかった件数 (下限より軽くて出さなかった確認済みの指摘の数。`minor` なら 0 件)、レビューした SHA だけ。
- 要確認は書かない。
