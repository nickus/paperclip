# Shell and state

Assume that every shell tool call starts a new shell, whatever your adapter:

- Shell variables, functions, `cd`, shell options and `trap`s from an earlier call are gone. A variable set in one call is empty in the next, so `"$W/c.md"` quietly becomes `/c.md`.
- Background processes (`cmd &`, `nohup cmd &`) may be killed when the call that started them returns. Some adapters kill the whole process group of the call.
- `/tmp` can be shared with other runs, and a reused sandbox keeps what earlier runs left there. A fixed name such as `/tmp/out.json` can hold another run's file.

## Where to keep files

`PAPERCLIP_RUN_SCRATCH_DIR` is a directory private to this run (mode `0700`). Paperclip creates it before the run starts, on the machine or in the sandbox where your commands run, and deletes it after the run ends. `PAPERCLIP_SCRATCH_DIR` names the same directory, and `TMPDIR` points at it unless your configuration sets `TMPDIR` itself, so `mktemp` uses it too.

- Write intermediate files under `"$PAPERCLIP_RUN_SCRATCH_DIR"` and spell the variable out in every call. Do not copy it into another shell variable and expect that variable in a later call.
- Do not keep pointer files (`echo "$f" > /tmp/current`) or rely on `trap … EXIT` for work that spans calls.
- Anything that must outlive the run belongs on the issue (comment, document, attachment, work product) or in the workspace, never in the scratch directory.
- If `PAPERCLIP_RUN_SCRATCH_DIR` is empty, run `mktemp -d` once and type the absolute path it prints into later commands literally.

A recipe split over two calls:

```bash
# call 1: write the comment body
cat > "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" <<'MD'
Build fixed.

- Root cause: stale lockfile
- Verified with a clean install
MD
```

```bash
# call 2: encode and post it, then check the HTTP status
jq -n --rawfile body "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" '{body: $body}' > "$PAPERCLIP_RUN_SCRATCH_DIR/comment.json"
curl -sS -o "$PAPERCLIP_RUN_SCRATCH_DIR/comment-response.json" -w '%{http_code}\n' \
  -X POST "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data-binary @"$PAPERCLIP_RUN_SCRATCH_DIR/comment.json"
```

## Long-running commands

- Run a command in the foreground of one call when it fits in the tool's time limit.
- If your tool has its own background-task feature, use it: it keeps the process alive between calls and lets you read its output.
- Otherwise detach the process into its own session and keep its log and PID in the scratch directory:

```bash
setsid nohup ./gradlew build > "$PAPERCLIP_RUN_SCRATCH_DIR/build.log" 2>&1 < /dev/null &
echo $! > "$PAPERCLIP_RUN_SCRATCH_DIR/build.pid"
```

Later calls read `tail -n 50 "$PAPERCLIP_RUN_SCRATCH_DIR/build.log"` and check `kill -0 "$(cat "$PAPERCLIP_RUN_SCRATCH_DIR/build.pid")"`. Stop what you started before you finish: the scratch directory is deleted after the run.

## Stopping processes: the `pkill -f` trap

`pkill -f PATTERN` matches full command lines, and the command line of the shell running your `pkill` contains PATTERN too. `pkill` then kills its own shell, so the call dies (exit code 143 or 144, depending on the tool) and the rest of its output is lost. Instead:

- kill by PID file: `kill "$(cat "$PAPERCLIP_RUN_SCRATCH_DIR/build.pid")"`;
- or use a bracket pattern, which still matches the process but not the text of your own command: `pkill -f '[f]etch_data.py'`;
- run `pgrep -af '[f]etch_data.py'` first to see what would be matched.

## API calls

- Take the API base URL from `$PAPERCLIP_API_URL` in every call. It can be a per-run bridge on a port that changes between runs, so a guessed `localhost` URL fails or reaches the wrong server.
- Check the HTTP status of every write (`-w '%{http_code}'`), and never pipe a write into `head`, `tail` or `jq` without it: a failed write then looks like success.
- Copy-paste payloads for the routes that are easy to get wrong are in `references/payload-cookbook.md`.
