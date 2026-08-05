# Update Diff Guard（開発／検証ビルド）

これは、フルのタブUIに作り込む前に、[Spec.md](Spec.md) の中で最もリスクの高い前提をFigma上で直接検証するための、機能を絞ったビルドです。

- `swapComponent()` は、実際に配置済みのインスタンスに対して、Figma純正の「Update」ボタンと同じようにオーバーライドを保持してくれるか？
- `swapComponent()` はノードの同一性を保つか（＝そのノードを参照しているFigJamの矢印コネクタが壊れずに残るか）？
- `importComponentByKeyAsync(key).id` と、インスタンスの現在の `mainComponent.id` を比較する方法で、「既に最新版」か「更新あり」かを確実に判定できるか？
- `exportAsync()` → `pixelmatch` という流れで、実用に足るBefore/After/Diff画像が得られるか？

ここでのUIは意図的にシンプルにしています（タブ・アコーディオン・マーキング機能なし、フラットな一覧のみ）。最終的なUI設計はSpec.mdを参照してください。

## セットアップ

```bash
npm install
npm run build
```

`npm run watch` を使うと、保存のたびに自動でビルドされます。

## Figmaへの読み込み方

1. Figmaデスクトップアプリを開く。
2. メニュー → Plugins → Development → **Import plugin from manifest…**
3. このフォルダ内の `manifest.json` を選択。
4. メニュー → Plugins → Development → **Update Diff Guard (dev)** を選んで実行。

Figmaが実際に読み込むのは `dist/code.js` と `dist/ui.html` です。ソースを変更したら再ビルドし、プラグインを再実行してください（再インポートは不要）。

## 動作確認でチェックすること

1. ライブラリ側に新しいパブリッシュ版があるコンポーネントのインスタンスを含むフレームを選択し、**Scan** を実行する。
2. 「更新あり」の行で **差分テスト** ボタンを押す。Before/After/Diffのサムネイルが正しく見えるか、差分率が実際に加えたオーバーライド（例: スイッチのON/OFF切り替え）から予想される内容と一致するかを確認する。
3. そのインスタンスにFigJamの矢印が接続されている場合、**適用（in-place swap）** ボタンを押し、更新後も矢印が繋がったままかを確認する（これがこのプロジェクト全体の存在理由となる制約。Spec.md §1参照）。
4. Ctrl+Zで元に戻し、インスタンスとテスト用に作られたノードが完全に復元されるかを確認する。
