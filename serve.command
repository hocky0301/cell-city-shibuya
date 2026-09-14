#!/bin/bash
# CELL CITY: SHIBUYA — ダブルクリックで起動
cd "$(dirname "$0")"
echo "CELL CITY: SHIBUYA を起動します → http://localhost:8123"
(sleep 1 && open "http://localhost:8123") &
python3 -m http.server 8123
