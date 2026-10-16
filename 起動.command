#!/bin/bash
# 営業サポートの同期サーバーを起動します(ダブルクリックで実行)。止めるときはこのウィンドウで Ctrl+C か、ウィンドウを閉じる。
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org/ から LTS 版をインストールしてから、もう一度ダブルクリックしてください。"
  read -r -p "Enter キーで閉じます"
  exit 1
fi
node server.js "$@"
read -r -p "サーバーが終了しました。Enter キーで閉じます"
