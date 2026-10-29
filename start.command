#!/bin/bash
cd "$(dirname "$0")"
echo "Hand Pulse 启动中…"
echo "请用 Safari 或 Chrome 打开： http://127.0.0.1:8765/"
echo "关闭本窗口即停止服务。"
echo ""
(sleep 1; open "http://127.0.0.1:8765/") &
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server 8765 --bind 127.0.0.1
else
  python -m http.server 8765 --bind 127.0.0.1
fi
