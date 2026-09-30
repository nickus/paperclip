#!/usr/bin/env bash
# The helper ships with the Paperclip skill, so installed skills carry it:
# skills/paperclip/scripts/paperclip-issue-update.sh. This path forwards to it
# for callers that run it from a repository checkout.
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/../skills/paperclip/scripts/paperclip-issue-update.sh" "$@"
