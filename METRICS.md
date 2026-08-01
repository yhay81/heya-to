# 指標

実利用は `product_events.is_qa = 0` だけを集計する。

## 流れ

- `visited`: 募集盤を開いた匿名利用者
- `room_created`: 募集灯を作った匿名利用者
- `room_code_copied`: 5桁をコピーした匿名利用者と対象室
- `entry_confirmed`: ゲーム内で入室できたと返した匿名利用者と対象室
- `board_filtered`: 目的で募集盤を絞った匿名利用者
- `room_managed`: 残り席、満室、延長を操作した募集主
- `returned`: 別の日ではなく再訪した匿名利用者の概数

イベントは名称、匿名セッション、対象室、JSTの日付の組み合わせで1日1件に制限する。`npm run metrics` で本番、`npm run metrics -- -Local` でローカルD1を集計する。
