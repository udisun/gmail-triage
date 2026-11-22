#!/bin/sh
# Test double for the claude CLI. The runner passes only an allowlisted env, so the mode and
# capture files live under $TMPDIR (allowlisted): fake-mode, fake-env.txt, fake-args.txt.
mode=$(cat "$TMPDIR/fake-mode" 2>/dev/null || echo ok)
env | cut -d= -f1 > "$TMPDIR/fake-env.txt"
printf '%s\n' "$@" > "$TMPDIR/fake-args.txt"
pwd -P > "$TMPDIR/fake-cwd.txt"
init='{"type":"system","subtype":"init","apiKeySource":"none","model":"claude-sonnet-5-5"}'
badinit='{"type":"system","subtype":"init","apiKeySource":"ANTHROPIC_API_KEY","model":"claude-sonnet-5-5"}'
asst='{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
ok='{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"verdicts":[{"id":"t1","bucket":"receipts","reason":"invoice"}]}}'
case "$mode" in
  apikey) echo "$badinit"; echo "$asst"; echo "$ok" ;;
  error) echo "$init"; echo "$asst"; echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}' ;;
  noresult) echo "$init"; echo "$asst" ;;
  hang) echo "$init"; exec sleep 30 ;;
  hang-stderr) echo "$init"; printf 'API Error:\n  Connection error\n' >&2; exec sleep 30 ;;
  lateapikey) echo "$init"; echo "$badinit"; echo "$ok" ;;
  dupinit) echo "$init"; echo "$init"; echo "$ok" ;;
  resultfirst) echo "$ok"; echo "$init" ;;
  assistantfirst) echo "$asst"; echo "$init"; echo "$ok" ;;
  dupresult) echo "$init"; echo "$ok"; echo "$ok" ;;
  garbage) echo "$init"; echo 'not json'; echo "$ok" ;;
  split) echo "$init"; printf '%s' '{"type":"result","subtype":"succ'; sleep 0.3; printf '%s\n' 'ess","is_error":false,"result":"done","structured_output":{"verdicts":[]}}' ;;
  *) echo "$init"; echo "$asst"; echo "$ok" ;;
esac
