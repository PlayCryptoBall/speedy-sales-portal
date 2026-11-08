#!/bin/bash
# usage: tests/reset_db.sh <dbname>   (local test Postgres on :54329)
set -e
export PGPASSWORD=pw
P="psql -h localhost -p 54329 -U postgres -q -v ON_ERROR_STOP=1"
$P -c "drop database if exists $1" -c "create database $1" >/dev/null
cd "$(dirname "$0")/.."
$P -d $1 -f tests/stub_supabase.sql
for f in supabase/migrations/00[1-58]*.sql; do  # 006 and 007 need pg_cron and Supabase Vault (Supabase only)
   $P -d $1 -f $f; done
