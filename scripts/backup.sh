#!/usr/bin/env bash
# 备份：sqlite3 .backup 在线快照（禁止 cp 热库）+ gzip + 滚动保留（deployment.md）
set -e
DB="${1:-${GB_PMO_DB:-data/gb-pmo.db}}"
OUT_DIR="${2:-backups}"
KEEP_DAYS="${GB_PMO_BACKUP_KEEP:-30}"
mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$OUT_DIR/gb-pmo-$STAMP.db.gz"
sqlite3 "$DB" ".backup '$OUT_DIR/.backup.tmp'"
gzip -c "$OUT_DIR/.backup.tmp" > "$OUT"
rm -f "$OUT_DIR/.backup.tmp"
chmod 600 "$OUT"
find "$OUT_DIR" -name 'gb-pmo-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $OUT"
