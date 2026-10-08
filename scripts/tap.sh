#!/bin/sh
# stdin/stdout을 wire/에 복사한다. stderr는 그대로. 인자: 서버 파일(기본 src/server.ts)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOG=${TAP_LOG:-$ROOT/wire/wire}
mkdir -p "$(dirname "$LOG")"
tee -a "$LOG.in" | bun "$ROOT/${1:-src/server.ts}" | tee -a "$LOG.out"
