# 付録: PR への投稿 (`--comment`)

`--comment` が付いているときだけ読む。端末への出力は、投稿するかどうかに関係なく先に出しておく。

## 投稿しない条件

次のどれかなら投稿せず、理由を端末に 1 行で出して終わる。

- 対象が PR ではない (手元の diff)。
- PR が閉じている (`gh pr view <n> --json state`)。
- このスキルのコメントがもうある (`gh pr view <n> --comments` に「## lens-review」で始まるコメントか、同じ見出しのインラインコメントがある)。

## 投稿の前に

出すコメントの一覧を自分で見直す (どこにも出さない)。同じ問題のコメントが 2 つ無いこと、要確認が入っていないことを確かめる。

## インラインコメント

- `mcp__github_inline_comment__create_inline_comment` があれば、指摘 1 件ごとにそれで出す (`confirmed: true`)。
- 無ければ、`gh api` で 1 つのレビューにまとめて出す (通知が 1 回で済む)。承認も却下もしない。

  ```bash
  gh api repos/<owner>/<repo>/pulls/<n>/reviews --method POST --input <一時フォルダ>/review.json
  ```

  `review.json` の形: `{"commit_id": "<head の完全な SHA>", "event": "COMMENT", "body": "<本文>", "comments": [{"path": "<file>", "line": <行>, "side": "RIGHT", "body": "<指摘>"}]}`。複数行なら `start_line` も付ける。行が diff に無いと 422 になるので、その指摘は本文に回す。
- 1 件の本文の順: 「**[重大度・手間] 見出し**」→ 理由 → 直し方 → 裏取り。日本語で書く。
- suggestion (````suggestion` のブロック) は、5 行以内で、それを入れるだけで直り切るときだけ付ける。続きの作業が要るなら文で書く。

## diff の外の行と、まとめのコメント

- diff の外の行に当たる指摘は、レビューの本文 (MCP の道具のときは `gh pr comment` の 1 コメント) に、`file:line` とリンクで並べる。
- リンクの形: `https://github.com/<owner>/<repo>/blob/<完全な SHA>/<path>#L<始め>-L<終わり>`。前後 1 行を含める (5〜6 行目なら `#L4-L7`)。`$(git rev-parse HEAD)` のような式は展開されないので、SHA を文字で書く。
- 本文の 1 行目は「## lens-review」。続けて端末の 1 行目 (件数) と、確認した観点。
- 指摘が無いとき: 「## lens-review」と「指摘なし。確認した観点: …」だけの 1 コメント。
