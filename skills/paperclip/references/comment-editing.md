# Editing an issue comment

`PATCH /api/issues/{issueId}/comments/{commentId}` lets the comment's author
edit that comment's `body` (author-only; see `references/api-reference.md`
for the full endpoint table and its authorization notes).

Editing a comment never wakes anyone, even if the edit adds a new @-mention
that would have woken someone had it been in the original comment. Post a
new comment (or a fresh mention) if you need to notify someone about edited
content.
