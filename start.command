#!/bin/zsh
cd "${0:A:h}" || exit 1
runtime_node="$(command -v node)"
if [[ -z "$runtime_node" || ! -x "$runtime_node" ]]; then
  print 'Install Node.js 22 or newer, then run pnpm install in this folder.'
  read '?Press Enter to close.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print 'Dependencies are missing. Run pnpm install in this folder first.'
  read '?Press Enter to close.'
  exit 1
fi
if curl --silent --fail 'http://127.0.0.1:2424' >/dev/null; then
  open 'http://127.0.0.1:2424'
  exit 0
fi
(
  for attempt in {1..40}; do
    if curl --silent --fail 'http://127.0.0.1:2424' >/dev/null; then
      open 'http://127.0.0.1:2424'
      exit 0
    fi
    sleep 0.15
  done
) &
exec "$runtime_node" scripts/dev.mjs --port 2424 --strictPort
