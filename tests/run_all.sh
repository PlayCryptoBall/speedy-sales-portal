#!/bin/bash
# Resets the three local test databases, loads the legacy import, and runs all suites. usage: tests/run_all.sh
cd "$(dirname "$0")/.."
export PGPASSWORD=pw
pkill -f "node tests/(server|ui[.]test)[.]mjs" 2>/dev/null; sleep 1
for d in t1 t2 t3; do bash tests/reset_db.sh $d >/dev/null 2>&1 || { echo "reset $d failed"; bash tests/reset_db.sh $d 2>&1 | grep -i error | head; exit 1; }
  psql -h localhost -p 54329 -U postgres -d $d -q -f "${IMPORT:-/home/claude/private/import_legacy.sql}" >/dev/null 2>&1; done
psql -h localhost -p 54329 -U postgres -d t3 -q -c "select private.rescore()" >/dev/null
node tests/workflows.test.mjs t1 2>&1 | grep -v "^PASS"
node --experimental-strip-types --no-warnings tests/parsers.test.mjs t2 2>&1 | grep -v "^PASS"
(node tests/server.mjs t3 8787 >/dev/null 2>&1 &); sleep 2
node tests/ui.test.mjs t3 8787 /home/claude/shots 2>&1 | grep -v "^PASS"
